import type { z } from "zod";
import type { Signature } from "./signature";
import type {
  ModuleASI,
  ModuleContext,
  ModuleTrace,
  ModuleTraceEvent,
  ModuleTraceStatus,
  TraceVisibility
} from "./types";
import { serializeError, sha256Hex, stringifyForStorage } from "./utils";

type AnyModule = Module<z.ZodTypeAny, z.ZodTypeAny>;

type TraceMetadata = Partial<
  Pick<
    ModuleTrace,
    | "modelId"
    | "adapterName"
    | "instructionVersion"
    | "contextVersion"
    | "demoVersion"
    | "usageJson"
  >
>;

type RuntimeModuleContext = ModuleContext & {
  asi: ModuleASI;
  trace: ModuleTraceRecorder;
};

export abstract class Module<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  #parent: AnyModule | null = null;
  #childName: string | null = null;
  #children = new Map<string, AnyModule>();

  constructor(readonly signature: Signature<I, O>) {}

  async invoke(
    context: ModuleContext,
    rawInput: z.input<I>
  ): Promise<z.output<O>> {
    const traceId = crypto.randomUUID();
    const modulePath = this.resolvePath();
    const createdAt = Date.now();
    const inputJson = stringifyForStorage(rawInput);
    const trace: ModuleTrace = {
      traceId,
      modulePath,
      signatureName: this.signature.name,
      moduleKind: this.getModuleKind(),
      status: "running",
      inputJson,
      outputJson: null,
      inputHash: await sha256Hex(inputJson),
      outputHash: null,
      modelId: null,
      adapterName: null,
      instructionVersion: "default",
      contextVersion: "default",
      demoVersion: "default",
      usageJson: null,
      latencyMs: null,
      errorJson: null,
      createdAt,
      finishedAt: null
    };

    await context.store?.beginTrace(trace);
    context.emit?.("module:trace:start", {
      traceId,
      modulePath,
      signatureName: this.signature.name,
      moduleKind: trace.moduleKind
    });

    const traceRecorder = new ModuleTraceRecorder(context, traceId);
    const runtimeContext: RuntimeModuleContext = {
      ...context,
      asi: traceRecorder.asi,
      trace: traceRecorder
    };

    let status: ModuleTraceStatus = "success";
    let outputJson: string | null = null;
    let outputHash: string | null = null;
    let parsedInput: z.output<I>;

    try {
      parsedInput = this.signature.input.parse(rawInput);
    } catch (error) {
      status = "validation_error";
      const errorJson = serializeError(error);

      await traceRecorder.append(
        "meta",
        "input_validation_failed",
        "warn",
        "Input validation failed.",
        { error: errorJson }
      );

      await this.finishTrace(context, traceId, {
        status,
        errorJson,
        latencyMs: Date.now() - createdAt,
        finishedAt: Date.now(),
        ...traceRecorder.metadata
      });

      context.emit?.("module:trace:finish", {
        traceId,
        modulePath,
        status
      });

      throw error;
    }

    try {
      const rawOutput = await this.forward(runtimeContext, parsedInput);
      const parsedOutput = this.signature.output.parse(rawOutput);

      outputJson = stringifyForStorage(parsedOutput);
      outputHash = await sha256Hex(outputJson);

      await this.finishTrace(context, traceId, {
        status,
        outputJson,
        outputHash,
        latencyMs: Date.now() - createdAt,
        finishedAt: Date.now(),
        ...traceRecorder.metadata
      });

      context.emit?.("module:trace:finish", {
        traceId,
        modulePath,
        status
      });

      return parsedOutput;
    } catch (error) {
      status = isValidationError(error) ? "validation_error" : "error";
      const errorJson = serializeError(error);

      if (status === "validation_error") {
        await traceRecorder.append(
          "asi",
          "output_validation_failed",
          "warn",
          "Output validation failed.",
          { error: errorJson }
        );
      } else {
        await traceRecorder.append(
          "meta",
          "module_failed",
          "error",
          "Module execution failed.",
          { error: errorJson }
        );
      }

      await this.finishTrace(context, traceId, {
        status,
        outputJson,
        outputHash,
        errorJson,
        latencyMs: Date.now() - createdAt,
        finishedAt: Date.now(),
        ...traceRecorder.metadata
      });

      context.emit?.("module:trace:finish", {
        traceId,
        modulePath,
        status
      });

      throw error;
    }

    // Unreachable, but TypeScript requires a return above.
  }

  protected abstract forward(
    context: RuntimeModuleContext,
    input: z.output<I>
  ): Promise<z.output<O>>;

  protected child<T extends AnyModule>(name: string, module: T): T {
    module.#parent = this;
    module.#childName = name;
    this.#children.set(name, module);
    return module;
  }

  protected getModuleKind(): string {
    return "module";
  }

  protected getChildren(): ReadonlyMap<string, AnyModule> {
    return this.#children;
  }

  private resolvePath(): string {
    if (this.#parent == null || this.#childName == null) {
      return this.signature.name;
    }

    return `${this.#parent.resolvePath()}.${this.#childName}`;
  }

  private async finishTrace(
    context: ModuleContext,
    traceId: string,
    update: Partial<Omit<ModuleTrace, "traceId">>
  ) {
    await context.store?.finishTrace(traceId, update);
  }
}

class ModuleTraceRecorder {
  readonly asi: ModuleASI;
  readonly metadata: TraceMetadata = {};
  #sequence = 0;

  constructor(
    private readonly context: ModuleContext,
    private readonly traceId: string
  ) {
    this.asi = {
      log: (message, payload) => {
        void this.append("asi", "log", "info", message, payload);
      },
      warn: (message, payload) => {
        void this.append("asi", "warning", "warn", message, payload);
      },
      error: (message, payload) => {
        void this.append("asi", "error", "error", message, payload);
      },
      metric: (name, value, payload) => {
        void this.append("asi", "metric", "info", `${name}: ${value}`, {
          ...payload,
          name,
          value
        });
      }
    };
  }

  setMetadata(metadata: TraceMetadata) {
    Object.assign(this.metadata, metadata);
  }

  async append(
    visibility: TraceVisibility,
    kind: string,
    level: "info" | "warn" | "error",
    message: string,
    payload?: Record<string, unknown>
  ) {
    const event: ModuleTraceEvent = {
      eventId: crypto.randomUUID(),
      traceId: this.traceId,
      seq: ++this.#sequence,
      visibility,
      kind,
      level,
      message,
      payloadJson: payload ? stringifyForStorage(payload) : null,
      createdAt: Date.now()
    };

    await this.context.store?.appendTraceEvent(event);
    this.context.emit?.("module:trace:event", {
      traceId: event.traceId,
      seq: event.seq,
      visibility: event.visibility,
      kind: event.kind,
      level: event.level,
      message: event.message
    });

    if (visibility === "asi") {
      this.context.asi?.log(message, payload);
    }
  }
}

function isValidationError(error: unknown): boolean {
  return !!(
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name: string }).name === "ZodError"
  );
}
