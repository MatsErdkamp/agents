import { generateText, Output, type LanguageModel } from "ai";
import {
  type ModuleArtifactType,
  type Module,
  type ModuleStore,
  type ModuleTrace,
  type ModuleTraceEvent
} from "@cloudflare/modules";
import { z } from "zod";

export interface OptimizerTraceRecord {
  trace: ModuleTrace;
  events: ModuleTraceEvent[];
}

export interface SignatureImprovementSuggestion {
  strategy: string;
  modulePath: string;
  summary: string;
  suggestedInstructions: string | null;
  suggestedInputFieldDescriptions: Record<string, string>;
  suggestedOutputFieldDescriptions: Record<string, string>;
  rationale: string[];
  evidence: Array<{
    traceId: string;
    modulePath: string;
    issue: string;
  }>;
  confidence: "low" | "medium" | "high";
}

export interface OptimizationContext {
  module: Module<z.ZodTypeAny, z.ZodTypeAny>;
  modulePath: string;
  traces: OptimizerTraceRecord[];
  model: LanguageModel;
}

export interface OptimizationStrategy {
  readonly name: string;
  suggest(
    context: OptimizationContext
  ): Promise<SignatureImprovementSuggestion>;
}

export interface EvolveSuggestOptions {
  module: Module<z.ZodTypeAny, z.ZodTypeAny>;
  store: ModuleStore;
  model: LanguageModel;
  modulePath?: string;
  includeChildren?: boolean;
  limitPerModule?: number;
}

export interface EvolveApplyOptions extends EvolveSuggestOptions {
  activate?: boolean;
}

export interface AppliedImprovement {
  strategy: string;
  modulePath: string;
  suggestion: SignatureImprovementSuggestion;
  appliedArtifacts: Partial<Record<ModuleArtifactType, string>>;
}

type GenerateTextFn = typeof generateText;

const suggestionSchema = z.object({
  summary: z.string(),
  suggestedInstructions: z.string().nullable(),
  suggestedInputFieldDescriptions: z.record(z.string(), z.string()),
  suggestedOutputFieldDescriptions: z.record(z.string(), z.string()),
  rationale: z.array(z.string()).min(1).max(3),
  evidence: z
    .array(
      z.object({
        traceId: z.string(),
        modulePath: z.string(),
        issue: z.string()
      })
    )
    .max(3),
  confidence: z.enum(["low", "medium", "high"])
});

export class TraceReviewStrategy implements OptimizationStrategy {
  readonly name = "trace-review";
  readonly #generateTextFn: GenerateTextFn;

  constructor(options?: { generateText?: GenerateTextFn }) {
    this.#generateTextFn = options?.generateText ?? generateText;
  }

  async suggest(
    context: OptimizationContext
  ): Promise<SignatureImprovementSuggestion> {
    if (context.traces.length === 0) {
      return {
        strategy: this.name,
        modulePath: context.modulePath,
        summary: "No traces available yet for this module.",
        suggestedInstructions: context.module.signature.instructions ?? null,
        suggestedInputFieldDescriptions: {},
        suggestedOutputFieldDescriptions: {},
        rationale: [
          "Run the module a few times before asking the optimizer to suggest changes."
        ],
        evidence: [],
        confidence: "low"
      };
    }

    const primaryPrompt = buildSuggestionPrompt(context, {
      maxTraces: 6,
      maxEventsPerTrace: 3,
      includeSchemas: true
    });
    const fallbackPrompt = buildSuggestionPrompt(context, {
      maxTraces: 3,
      maxEventsPerTrace: 2,
      includeSchemas: false
    });

    let result: Awaited<ReturnType<GenerateTextFn>>;

    try {
      result = await this.generateSuggestion(context, primaryPrompt);
    } catch (error) {
      try {
        result = await this.generateSuggestion(context, fallbackPrompt, error);
      } catch (fallbackError) {
        return buildHeuristicSuggestion(
          context,
          fallbackError instanceof Error
            ? fallbackError
            : error instanceof Error
              ? error
              : new Error("Optimization model request failed")
        );
      }
    }

    return {
      strategy: this.name,
      modulePath: context.modulePath,
      ...result.output
    };
  }

  private async generateSuggestion(
    context: OptimizationContext,
    prompt: string,
    previousError?: unknown
  ): Promise<Awaited<ReturnType<GenerateTextFn>>> {
    const retryNote = previousError
      ? `The previous structured-output attempt failed. Return a compact object and keep every string concise.`
      : undefined;

    return this.#generateTextFn({
      model: context.model,
      system: [
        "You review module traces and suggest concrete improvements.",
        "Prefer improving instructions first.",
        "Only suggest field description changes when the trace evidence shows a missing or unclear field contract.",
        "Do not suggest infrastructure, model, provider, or adapter changes.",
        "Return concise output. Keep rationale and evidence tightly tied to the trace payload.",
        retryNote
      ]
        .filter(Boolean)
        .join("\n"),
      prompt,
      temperature: 0,
      maxOutputTokens: previousError ? 700 : 900,
      output: Output.object({
        schema: suggestionSchema,
        name: "module_improvement_suggestion",
        description:
          "A trace-based suggestion for improving module instructions or signature guidance."
      })
    });
  }
}

export class Evolve {
  readonly #strategies: OptimizationStrategy[];

  constructor(options?: { strategies?: OptimizationStrategy[] }) {
    this.#strategies = options?.strategies ?? [new TraceReviewStrategy()];
  }

  async suggest(
    options: EvolveSuggestOptions
  ): Promise<SignatureImprovementSuggestion[]> {
    const context = await loadOptimizationContext(options);

    return Promise.all(
      this.#strategies.map((strategy) => strategy.suggest(context))
    );
  }

  async apply(options: EvolveApplyOptions): Promise<AppliedImprovement[]> {
    const suggestions = await this.suggest(options);
    const activate = options.activate ?? true;

    return Promise.all(
      suggestions.map(async (suggestion) => {
        const appliedArtifacts: Partial<Record<ModuleArtifactType, string>> =
          {};
        const now = Date.now();
        const currentInputFieldDescriptions = await getCurrentFieldDescriptions(
          options.store,
          suggestion.modulePath,
          "input-field-descriptions",
          options.module.signature.inputFieldDescriptions
        );
        const currentOutputFieldDescriptions =
          await getCurrentFieldDescriptions(
            options.store,
            suggestion.modulePath,
            "output-field-descriptions",
            options.module.signature.outputFieldDescriptions
          );

        const instructionsArtifactId = await saveArtifactIfPresent({
          store: options.store,
          modulePath: suggestion.modulePath,
          artifactType: "instructions",
          value: suggestion.suggestedInstructions,
          createdAt: now,
          activate
        });

        if (instructionsArtifactId) {
          appliedArtifacts.instructions = instructionsArtifactId;
        }

        const inputFieldDescriptionsArtifactId = await saveArtifactIfPresent({
          store: options.store,
          modulePath: suggestion.modulePath,
          artifactType: "input-field-descriptions",
          value: mergeFieldDescriptions(
            currentInputFieldDescriptions,
            suggestion.suggestedInputFieldDescriptions
          ),
          createdAt: now,
          activate,
          skipIfEmpty: true
        });

        if (inputFieldDescriptionsArtifactId) {
          appliedArtifacts["input-field-descriptions"] =
            inputFieldDescriptionsArtifactId;
        }

        const outputFieldDescriptionsArtifactId = await saveArtifactIfPresent({
          store: options.store,
          modulePath: suggestion.modulePath,
          artifactType: "output-field-descriptions",
          value: mergeFieldDescriptions(
            currentOutputFieldDescriptions,
            suggestion.suggestedOutputFieldDescriptions
          ),
          createdAt: now,
          activate,
          skipIfEmpty: true
        });

        if (outputFieldDescriptionsArtifactId) {
          appliedArtifacts["output-field-descriptions"] =
            outputFieldDescriptionsArtifactId;
        }

        return {
          strategy: suggestion.strategy,
          modulePath: suggestion.modulePath,
          suggestion,
          appliedArtifacts
        };
      })
    );
  }
}

async function getCurrentFieldDescriptions(
  store: ModuleStore,
  modulePath: string,
  artifactType: "input-field-descriptions" | "output-field-descriptions",
  base: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
  const artifact = await store.getActiveArtifact(modulePath, artifactType);

  if (!artifact) {
    return { ...base };
  }

  try {
    return {
      ...base,
      ...(JSON.parse(artifact.contentJson) as Record<string, string>)
    };
  } catch {
    return { ...base };
  }
}

export async function loadOptimizationContext(
  options: EvolveSuggestOptions
): Promise<OptimizationContext> {
  const modulePath = options.modulePath ?? options.module.getPath();
  const modulePaths = options.includeChildren
    ? options.module
        .getModuleEntries()
        .map((entry) => entry.path)
        .filter(
          (path) => path === modulePath || path.startsWith(`${modulePath}.`)
        )
    : [modulePath];

  const traces = (
    await Promise.all(
      modulePaths.map(async (path) => {
        const pathTraces = await options.store.getTraces(path, {
          limit: options.limitPerModule ?? 5
        });

        return Promise.all(
          pathTraces.map(async (trace) => ({
            trace,
            events: await options.store.getTraceEvents(trace.traceId)
          }))
        );
      })
    )
  )
    .flat()
    .sort((left, right) => right.trace.createdAt - left.trace.createdAt);

  return {
    module: options.module,
    modulePath,
    traces,
    model: options.model
  };
}

function stringifySchema(schema: z.ZodTypeAny): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}

function buildSuggestionPrompt(
  context: OptimizationContext,
  options: {
    maxTraces: number;
    maxEventsPerTrace: number;
    includeSchemas: boolean;
  }
): string {
  const sections = [
    `Module path: ${context.modulePath}`,
    `Current instructions: ${context.module.signature.instructions ?? "(none)"}`,
    `Current input field descriptions: ${JSON.stringify(
      context.module.signature.inputFieldDescriptions,
      null,
      2
    )}`,
    `Current output field descriptions: ${JSON.stringify(
      context.module.signature.outputFieldDescriptions,
      null,
      2
    )}`,
    `Trace summary: ${JSON.stringify(
      summarizeTraces(context.traces, options),
      null,
      2
    )}`,
    "Rules: favor instruction edits over field description edits. Only change field descriptions when the traces show a recurring field misunderstanding."
  ];

  if (options.includeSchemas) {
    sections.splice(
      2,
      0,
      `Input schema JSON Schema: ${stringifySchema(context.module.signature.input)}`,
      `Output schema JSON Schema: ${stringifySchema(context.module.signature.output)}`
    );
  }

  return sections.join("\n\n");
}

function mergeFieldDescriptions(
  base: Readonly<Record<string, string>>,
  suggestion: Record<string, string>
): Record<string, string> {
  return {
    ...base,
    ...suggestion
  };
}

async function saveArtifactIfPresent(options: {
  store: ModuleStore;
  modulePath: string;
  artifactType: ModuleArtifactType;
  value: string | Record<string, string> | null;
  createdAt: number;
  activate: boolean;
  skipIfEmpty?: boolean;
}): Promise<string | null> {
  if (options.value == null) {
    return null;
  }

  if (
    options.skipIfEmpty &&
    typeof options.value === "object" &&
    Object.keys(options.value).length === 0
  ) {
    return null;
  }

  const artifactId = crypto.randomUUID();
  const version = `${options.artifactType}-${options.createdAt}`;

  await options.store.saveArtifact({
    artifactId,
    modulePath: options.modulePath,
    artifactType: options.artifactType,
    version,
    contentJson: JSON.stringify(options.value),
    createdAt: options.createdAt,
    isActive: options.activate
  });

  if (options.activate) {
    await options.store.activateArtifact(
      options.modulePath,
      options.artifactType,
      artifactId
    );
  }

  return artifactId;
}

function summarizeTraces(
  traces: OptimizerTraceRecord[],
  options: {
    maxTraces: number;
    maxEventsPerTrace: number;
  }
) {
  return traces.slice(0, options.maxTraces).map(({ trace, events }) => ({
    traceId: trace.traceId,
    modulePath: trace.modulePath,
    status: trace.status,
    latencyMs: trace.latencyMs,
    input: summarizeStoredJson(trace.inputJson),
    output: summarizeStoredJson(trace.outputJson),
    error: summarizeStoredJson(trace.errorJson),
    asiEvents: events
      .filter((event) => event.visibility === "asi")
      .slice(0, options.maxEventsPerTrace)
      .map((event) => ({
        kind: event.kind,
        level: event.level,
        message: truncateText(event.message, 220),
        payload: summarizeStoredJson(event.payloadJson)
      }))
  }));
}

function summarizeStoredJson(value: string | null): unknown {
  if (value == null) {
    return null;
  }

  try {
    return summarizeValue(JSON.parse(value));
  } catch {
    return truncateText(value, 320);
  }
}

function summarizeValue(value: unknown, depth = 0): unknown {
  if (
    value == null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value, 220);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 4).map((entry) => summarizeValue(entry, depth + 1));
  }

  if (typeof value !== "object") {
    return truncateText(String(value), 220);
  }

  if (depth >= 2) {
    return "[truncated object]";
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 8)
      .map(([key, entry]) => [key, summarizeValue(entry, depth + 1)])
  );
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildHeuristicSuggestion(
  context: OptimizationContext,
  error: Error
): SignatureImprovementSuggestion {
  const issues = context.traces
    .flatMap(({ trace, events }) => {
      const messages = events
        .filter((event) => event.visibility === "asi")
        .map((event) => event.message);

      if (messages.length > 0) {
        return messages.map((message) => ({
          traceId: trace.traceId,
          modulePath: trace.modulePath,
          issue: truncateText(message, 220)
        }));
      }

      if (trace.errorJson) {
        return [
          {
            traceId: trace.traceId,
            modulePath: trace.modulePath,
            issue: truncateText(trace.errorJson, 220)
          }
        ];
      }

      return [];
    })
    .slice(0, 3);

  const summary =
    issues.length > 0
      ? "Workers AI failed during optimization, but recent trace issues were summarized heuristically."
      : "Workers AI failed during optimization and there was not enough actionable trace data to summarize.";

  const rationale = [
    "The optimizer request hit an upstream inference error, so this suggestion was generated from stored traces instead of a model review."
  ];

  if (issues.some((issue) => issue.issue.toLowerCase().includes("missing"))) {
    rationale.push(
      "Recent traces mention missing fields or identifiers, so tightening instructions and field descriptions should help."
    );
  }

  return {
    strategy: "trace-review-fallback",
    modulePath: context.modulePath,
    summary,
    suggestedInstructions:
      context.module.signature.instructions != null
        ? `${context.module.signature.instructions}\n\nIf required identifiers or fields are missing, ask for them explicitly before proceeding.`
        : "If required identifiers or fields are missing, ask for them explicitly before proceeding.",
    suggestedInputFieldDescriptions: issues.some((issue) =>
      issue.issue.toLowerCase().includes("missing")
    )
      ? {
          query:
            "Include the full customer request and any required identifiers. If identifiers are missing, ask for them before proceeding."
        }
      : {},
    suggestedOutputFieldDescriptions: {},
    rationale,
    evidence: issues,
    confidence: "low"
  };
}
