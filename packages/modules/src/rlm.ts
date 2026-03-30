import { z } from "zod";
import { Module } from "./module";
import { Predict } from "./predict";
import { signature, type Signature } from "./signature";
import type { ModuleContext, TraceVisibility } from "./types";
import { RLMHistory, type RLMEntry, type RLMOptions } from "./rlm-types";
import { stableStringify, stringifyForStorage } from "./utils";

const JS_FENCE_LANGS = new Set(["", "js", "javascript", "ts", "typescript"]);

const ACTION_INSTRUCTIONS = `You are operating a shell-backed Recursive Language Model.

The full context is NOT in this prompt. It lives in the filesystem under the provided context root.
You must explore it programmatically with state.* before making conclusions.

Available in the sandbox:
- state.* from @cloudflare/shell for file and JSON exploration
- scratch: persistent mutable object that survives across iterations
- query(prompt, options?): semantic subquery over a snippet or subtask
- queryBatch(prompts, options?): batched semantic subqueries
- getR2TextInfo(path): inspect a "*.r2.txt" pointer for a large text artifact
- readR2Text(path, options?): read a slice of an R2-backed text artifact
- searchR2Text(path, query, options?): search within an R2-backed text artifact
- locateR2TextFractions(path, fractions): map fractions like 0.25 to R2 text offsets
- readR2TextAtFraction(path, fraction, options?): inspect text around a fraction of an R2 text
- SUBMIT({ ... }): finish with the final typed output object
- console.log / console.warn / console.error

Rules:
1. Explore the context before answering.
2. Use state.* to inspect files under the provided context root.
3. Keep reusable derived state in scratch.
4. Use query/queryBatch only for semantic decomposition after you have read the needed snippet(s).
5. Always log what you inspected so the next step can build on it.
6. Only call SUBMIT when you have verified the result.
7. If a file is stored as "*.r2.txt", inspect the pointer and then use the R2 helpers to read the actual text.
8. Return only JavaScript or TypeScript code.`;

const EXTRACT_INSTRUCTIONS = `Produce the final structured output from the RLM trajectory.

Use the resource metadata and REPL history to extract the best final answer.`;

type RLMTraceRecorder = {
  setMetadata(metadata: Record<string, string | null>): void;
  append(
    visibility: TraceVisibility,
    kind: string,
    level: "info" | "warn" | "error",
    message: string,
    payload?: Record<string, unknown>
  ): Promise<void>;
};

type RuntimeRLMContext = ModuleContext & {
  resolved: {
    instructions?: string;
  };
  trace: RLMTraceRecorder;
};

export class RLM<I extends z.ZodTypeAny, O extends z.ZodTypeAny> extends Module<
  I,
  O
> {
  readonly #runtime: RLMOptions["runtime"];
  readonly #queryProvider: RLMOptions["queryProvider"];
  readonly #maxIterations: number;
  readonly #maxQueryCalls: number;
  readonly #maxOutputChars: number;
  readonly #verbose: boolean;
  readonly #act: Predict<
    z.ZodObject<{
      contextRoot: z.ZodString;
      contextManifest: z.ZodString;
      replHistory: z.ZodString;
      iteration: z.ZodString;
      queryBudget: z.ZodString;
    }>,
    z.ZodObject<{
      reasoning: z.ZodString;
      code: z.ZodString;
    }>
  >;
  readonly #extract: Predict<
    z.ZodObject<{
      contextRoot: z.ZodString;
      contextManifest: z.ZodString;
      replHistory: z.ZodString;
    }>,
    O
  >;
  constructor(signatureShape: Signature<I, O>, options: RLMOptions) {
    super(signatureShape);
    this.#runtime = options.runtime;
    this.#queryProvider = options.queryProvider;
    this.#maxIterations = options.maxIterations ?? 64;
    this.#maxQueryCalls = options.maxQueryCalls ?? 128;
    this.#maxOutputChars = options.maxOutputChars ?? 10_000;
    this.#verbose = options.verbose ?? false;

    this.#act = this.child(
      "act",
      new Predict(buildActionSignature(signatureShape), {
        adapter: options.actAdapter
      })
    );
    this.#extract = this.child(
      "extract",
      new Predict(buildExtractSignature(signatureShape), {
        adapter: options.extractAdapter
      })
    );
  }

  protected override getModuleKind(): string {
    return "rlm";
  }

  protected override async forward(
    context: RuntimeRLMContext,
    input: z.output<I>
  ): Promise<z.output<O>> {
    context.trace.setMetadata({
      adapterName: "rlm",
      modelId: describeModel(context.model)
    });

    const session = await this.#runtime.createSession();
    let history = new RLMHistory([], {
      maxOutputChars: this.#maxOutputChars
    });
    let queryCallsUsed = 0;

    try {
      await context.trace.append(
        "meta",
        "rlm_session_started",
        "info",
        "RLM session started.",
        {
          maxIterations: this.#maxIterations,
          maxQueryCalls: this.#maxQueryCalls
        }
      );

      const preparedContext = await session.prepareContext(
        input as Record<string, unknown>
      );

      await context.trace.append(
        "meta",
        "rlm_context_prepared",
        "info",
        "Prepared shell-backed RLM context.",
        {
          contextRoot: preparedContext.contextRoot,
          manifestPath: preparedContext.manifestPath,
          resourceCount: preparedContext.resources.length
        }
      );

      let scratch: Record<string, unknown> = {};

      for (let iteration = 0; iteration < this.#maxIterations; iteration += 1) {
        await context.trace.append(
          "meta",
          "rlm_iteration_started",
          "info",
          `Starting RLM iteration ${iteration + 1}.`,
          {
            iteration: iteration + 1,
            maxIterations: this.#maxIterations,
            queryCallsUsed,
            maxQueryCalls: this.#maxQueryCalls
          }
        );

        const action = await this.#act.invoke(context, {
          contextRoot: preparedContext.contextRoot,
          contextManifest: preparedContext.manifestSummary,
          replHistory: history.format(),
          iteration: `${iteration + 1}/${this.#maxIterations}`,
          queryBudget: `${queryCallsUsed}/${this.#maxQueryCalls} used`
        });

        const code = stripCodeFences(action.code);

        if (this.#verbose) {
          await context.trace.append(
            "meta",
            "rlm_action_generated",
            "info",
            "Generated RLM code step.",
            {
              iteration: iteration + 1,
              reasoning: action.reasoning,
              code
            }
          );
        }

        let stepResult: Awaited<ReturnType<typeof session.executeStep>>;
        try {
          stepResult = await session.executeStep({
            code,
            context: preparedContext,
            scratch,
            queryProvider: this.#queryProvider,
            maxQueryCalls: this.#maxQueryCalls,
            queryCallsUsed
          });
        } catch (err) {
          stepResult = {
            scratch,
            logs: [],
            queryCallsUsed,
            error:
              err instanceof Error
                ? `Step execution crashed: ${err.message}`
                : `Step execution crashed: ${String(err)}`
          };
        }

        scratch = stepResult.scratch;
        queryCallsUsed = stepResult.queryCallsUsed;

        await context.trace.append(
          stepResult.error ? "asi" : "meta",
          stepResult.error ? "rlm_step_failed" : "rlm_step_completed",
          stepResult.error ? "warn" : "info",
          stepResult.error
            ? `RLM step failed: ${stepResult.error}`
            : "RLM step executed.",
          {
            iteration: iteration + 1,
            queryCallsUsed,
            logs: stepResult.logs,
            scratch: stringifyForStorage(scratch)
          }
        );

        const submission = await this.#maybeProcessSubmission(
          context,
          action.reasoning,
          code,
          stepResult,
          history
        );

        if (submission?.success) {
          return submission.output;
        }

        history =
          submission?.history ??
          appendHistoryEntry(history, {
            reasoning: action.reasoning,
            code,
            output: formatStepOutput(stepResult)
          });
      }

      await context.trace.append(
        "asi",
        "rlm_extract_fallback",
        "warn",
        "RLM hit max iterations; falling back to extract.",
        {
          maxIterations: this.#maxIterations,
          queryCallsUsed
        }
      );

      return this.#extract.invoke(context, {
        contextRoot: preparedContext.contextRoot,
        contextManifest: preparedContext.manifestSummary,
        replHistory: history.format()
      });
    } finally {
      await session.close();
    }
  }

  async #maybeProcessSubmission(
    context: RuntimeRLMContext,
    reasoning: string,
    code: string,
    stepResult: {
      submitted?: unknown;
      logs: string[];
      error?: string;
    },
    history: RLMHistory
  ): Promise<
    | { success: true; output: z.output<O>; history: RLMHistory }
    | { success: false; history: RLMHistory }
    | null
  > {
    if (stepResult.submitted === undefined) {
      return null;
    }

    try {
      const parsed = this.signature.output.parse(stepResult.submitted);
      const nextHistory = appendHistoryEntry(history, {
        reasoning,
        code,
        output: formatStepOutput({
          ...stepResult,
          logs: [
            ...stepResult.logs,
            `SUBMIT: ${stableStringify(stepResult.submitted)}`
          ]
        })
      });

      await context.trace.append(
        "meta",
        "rlm_submitted",
        "info",
        "RLM submitted final output.",
        {
          output: stepResult.submitted
        }
      );

      return { success: true, output: parsed, history: nextHistory };
    } catch (error) {
      const nextHistory = appendHistoryEntry(history, {
        reasoning,
        code,
        output: formatStepOutput({
          ...stepResult,
          error: formatSubmitValidationError(error)
        })
      });

      await context.trace.append(
        "asi",
        "rlm_submit_validation_failed",
        "warn",
        "RLM submitted an invalid output payload.",
        {
          output: stepResult.submitted,
          error:
            error instanceof Error ? error.message : "Unknown validation error"
        }
      );

      return { success: false, history: nextHistory };
    }
  }
}

function buildActionSignature<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  signatureShape: Signature<I, O>
) {
  return signature(`${signatureShape.name}Act`)
    .withInput(
      z.object({
        contextRoot: z.string(),
        contextManifest: z.string(),
        replHistory: z.string(),
        iteration: z.string(),
        queryBudget: z.string()
      })
    )
    .withOutput(
      z.object({
        reasoning: z.string(),
        code: z.string()
      })
    )
    .withInstructions(
      [
        signatureShape.instructions?.trim(),
        ACTION_INSTRUCTIONS,
        "Expected output fields:",
        formatOutputFields(signatureShape)
      ]
        .filter(Boolean)
        .join("\n\n")
    );
}

function buildExtractSignature<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  signatureShape: Signature<I, O>
) {
  return signature(`${signatureShape.name}Extract`)
    .withInput(
      z.object({
        contextRoot: z.string(),
        contextManifest: z.string(),
        replHistory: z.string()
      })
    )
    .withOutput(signatureShape.output)
    .withInstructions(
      [
        signatureShape.instructions?.trim(),
        EXTRACT_INSTRUCTIONS,
        "Expected output fields:",
        formatOutputFields(signatureShape)
      ]
        .filter(Boolean)
        .join("\n\n")
    );
}

function formatOutputFields<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  signatureShape: Signature<I, O>
): string {
  const shape = extractShape(signatureShape.output);
  return Object.keys(shape)
    .map((key) => {
      const description = signatureShape.outputFieldDescriptions[key];
      return description ? `- ${key}: ${description}` : `- ${key}`;
    })
    .join("\n");
}

function extractShape(schema: z.ZodTypeAny): z.ZodRawShape {
  if (schema instanceof z.ZodObject) {
    return schema.shape;
  }
  return {};
}

function appendHistoryEntry(history: RLMHistory, entry: RLMEntry): RLMHistory {
  return history.append(entry);
}

function formatStepOutput(result: { logs: string[]; error?: string }): string {
  const lines = [...result.logs];
  if (result.error) {
    lines.push(`[Error] ${result.error}`);
  }
  if (lines.length === 0) {
    return "(no output - use console.log to inspect results)";
  }
  return lines.join("\n");
}

function formatSubmitValidationError(error: unknown): string {
  if (error instanceof Error) {
    return `SUBMIT payload validation failed: ${error.message}`;
  }
  return "SUBMIT payload validation failed.";
}

function stripCodeFences(code: string): string {
  const trimmed = code.trim();
  if (!trimmed.includes("```")) {
    return trimmed;
  }

  const start = trimmed.indexOf("```");
  const rest = trimmed.slice(start + 3);
  const newlineIndex = rest.indexOf("\n");
  if (newlineIndex === -1) {
    return trimmed;
  }

  const rawLang = rest.slice(0, newlineIndex).trim().toLowerCase();
  const language = rawLang.split(/\s+/, 1)[0] ?? "";
  if (!JS_FENCE_LANGS.has(language)) {
    throw new SyntaxError(
      `Expected JavaScript or TypeScript code, received \`\`\`${language}\`.`
    );
  }

  const body = rest.slice(newlineIndex + 1);
  const end = body.lastIndexOf("```");
  return (end === -1 ? body : body.slice(0, end)).trim();
}

function describeModel(model: ModuleContext["model"]): string {
  if (typeof model === "string") {
    return model;
  }

  if (
    typeof model === "object" &&
    model !== null &&
    "provider" in model &&
    "modelId" in model &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string"
  ) {
    return `${model.provider}:${model.modelId}`;
  }

  if (
    typeof model === "object" &&
    model !== null &&
    "modelId" in model &&
    typeof model.modelId === "string"
  ) {
    return model.modelId;
  }

  return "unknown";
}
