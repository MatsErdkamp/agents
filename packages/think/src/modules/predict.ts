import type { z } from "zod";
import { Module } from "./module";
import type { Signature } from "./signature";
import type { ModuleContext } from "./types";
import { AISDKGenerateTextAdapter, type PredictAdapter } from "./adapter";

const defaultAdapter = new AISDKGenerateTextAdapter();

export class Predict<
  I extends z.ZodTypeAny,
  O extends z.ZodTypeAny
> extends Module<I, O> {
  readonly #adapter: PredictAdapter;

  constructor(
    signature: Signature<I, O>,
    options?: { adapter?: PredictAdapter }
  ) {
    super(signature);
    this.#adapter = options?.adapter ?? defaultAdapter;
  }

  protected override getModuleKind(): string {
    return "predict";
  }

  protected override async forward(
    context: ModuleContext & {
      trace: {
        setMetadata(metadata: Record<string, string | null>): void;
        append(
          visibility: "asi" | "meta",
          kind: string,
          level: "info" | "warn" | "error",
          message: string,
          payload?: Record<string, unknown>
        ): Promise<void>;
      };
    },
    input: z.output<I>
  ): Promise<z.output<O>> {
    const result = await this.#adapter.execute(context, this.signature, input);
    return this.signature.output.parse(result.output);
  }
}
