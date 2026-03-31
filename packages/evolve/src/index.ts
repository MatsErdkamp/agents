import { generateText, Output, type LanguageModel } from "ai";
import {
  type ModuleArtifactType,
  type Module,
  type ModuleContext,
  type ModuleFeedback,
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

export interface EvolveExample {
  exampleId: string;
  modulePath: string;
  traceId?: string;
  input: unknown;
  baselineOutput: unknown;
  baselineError: unknown;
  trace?: ModuleTrace;
  events: ModuleTraceEvent[];
  feedback: ModuleFeedback[];
  asi: Array<{
    kind: string;
    level: "info" | "warn" | "error";
    message: string;
    payload: unknown;
  }>;
  metadata?: Record<string, unknown>;
}

export interface EvolveExampleScore {
  exampleId: string;
  score: number;
  output?: unknown;
  error?: unknown;
  traceId?: string;
}

export interface EvolveEvaluationResult {
  averageScore: number;
  perExample: EvolveExampleScore[];
}

export interface EvolveEvaluationBatch extends EvolveEvaluationResult {
  batchId: string;
  epoch: number;
  minibatchIndex: number;
  exampleIds: string[];
}

export type EvolveTextComponentKind =
  | "instructions"
  | "input-field-description"
  | "output-field-description";

export interface EvolveTextComponent {
  id: string;
  modulePath: string;
  artifactType: ModuleArtifactType;
  fieldName: string | null;
  kind: EvolveTextComponentKind;
  label: string;
  currentValue: string;
}

export interface EvolveCandidate {
  candidateId: string;
  modulePath: string;
  instructions: string | null;
  parameters: Record<string, string>;
  source: "seed" | "mutation" | "merge";
  generation: number;
  component: string;
  componentLabel: string;
  summary: string;
  rationale: string[];
  parentCandidateId: string | null;
  mergedCandidateIds: string[];
  createdAt: number;
  minibatchScore: number | null;
  validationScore: number | null;
  accepted: boolean;
  promoted: boolean;
  perExampleScores: Record<string, number>;
  appliedArtifacts?: Partial<Record<ModuleArtifactType, string>>;
  appliedArtifactsByModule?: Record<
    string,
    Partial<Record<ModuleArtifactType, string>>
  >;
}

export interface EvolveArchiveEntry {
  candidateId: string;
  validationScore: number;
  rank: number;
  dominates: string[];
}

export interface EvolveRunState {
  runId: string;
  modulePath: string;
  seedCandidateId: string;
  bestCandidateId: string;
  trainingExampleIds: string[];
  validationExampleIds: string[];
  iteration: number;
  epoch: number;
  successes: number;
  mergeAttempts: number;
  startedAt: number;
}

export interface EvolveRunSummary {
  runId: string;
  modulePath: string;
  status: "running" | "completed" | "failed";
  seedCandidateId: string | null;
  bestCandidateId: string | null;
  seedValidationScore: number | null;
  bestValidationScore: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface EvolveRunResult {
  run: EvolveRunState;
  seedCandidate: EvolveCandidate;
  bestCandidate: EvolveCandidate;
  candidates: EvolveCandidate[];
  archive: EvolveArchiveEntry[];
  appliedArtifacts: Partial<Record<ModuleArtifactType, string>>;
  appliedArtifactsByModule: Record<
    string,
    Partial<Record<ModuleArtifactType, string>>
  >;
  trainingExamples: EvolveExample[];
  validationExamples: EvolveExample[];
}

export interface EvolveStore {
  beginRun(run: EvolveRunState): Promise<void>;
  saveCandidate(runId: string, candidate: EvolveCandidate): Promise<void>;
  finishRun(
    runId: string,
    update: {
      status: "completed" | "failed";
      bestCandidateId: string | null;
      seedValidationScore: number | null;
      bestValidationScore: number | null;
      finishedAt: number;
    }
  ): Promise<void>;
  listRuns(options?: {
    modulePath?: string;
    limit?: number;
  }): Promise<EvolveRunSummary[]>;
  getCandidates(runId: string): Promise<EvolveCandidate[]>;
}

export interface EvolveAdapter {
  loadExamples(options: {
    module: Module<z.ZodTypeAny, z.ZodTypeAny>;
    store: ModuleStore;
    modulePath: string;
    includeChildren?: boolean;
    limitPerModule?: number;
  }): Promise<EvolveExample[]>;
  evaluateCandidate(options: {
    module: Module<z.ZodTypeAny, z.ZodTypeAny>;
    store: ModuleStore;
    modulePath: string;
    candidate: EvolveCandidate;
    examples: EvolveExample[];
    context: ModuleContext;
  }): Promise<EvolveEvaluationResult>;
  renderExample?(example: EvolveExample): string;
}

export interface BatchSampler {
  nextBatch(): {
    epoch: number;
    minibatchIndex: number;
    examples: EvolveExample[];
  };
}

export interface CandidateSelector {
  selectCandidate(options: {
    candidates: EvolveCandidate[];
    exampleIds: string[];
  }): EvolveCandidate;
}

export interface ComponentSelector {
  nextComponent(options: {
    components: EvolveTextComponent[];
    iteration: number;
    candidates: EvolveCandidate[];
  }): EvolveTextComponent;
}

export interface ModuleTraceAdapterOptions {
  score?: (options: {
    example: EvolveExample;
    output: unknown;
    error: unknown;
    traceId?: string;
  }) => Promise<number> | number;
  eventLimit?: number;
  feedbackLimit?: number;
}

export interface EvolveOptimizeOptions {
  module: Module<z.ZodTypeAny, z.ZodTypeAny>;
  store: ModuleStore;
  reflectionModel: LanguageModel;
  executionContext?: Omit<ModuleContext, "store">;
  adapter?: EvolveAdapter;
  evolveStore?: EvolveStore;
  modulePath?: string;
  includeChildren?: boolean;
  limitPerModule?: number;
  activate?: boolean;
  seedInstructions?: string | null;
  seedParameters?: Record<string, string>;
  maxIterations?: number;
  minibatchSize?: number;
  validationSplit?: number;
  mergeEvery?: number;
  random?: () => number;
  batchSampler?: BatchSampler;
  candidateSelector?: CandidateSelector;
  componentSelector?: ComponentSelector;
}

type GenerateTextFn = typeof generateText;
type SqlPrimitive = string | number | boolean | null;
type SqlFn = (
  strings: TemplateStringsArray,
  ...values: SqlPrimitive[]
) => Array<Record<string, unknown>>;

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

const mutationSchema = z.object({
  summary: z.string(),
  instructions: z.string(),
  rationale: z.array(z.string()).min(1).max(4)
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
      ? "The previous structured-output attempt failed. Return a compact object and keep every string concise."
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

export class ModuleTraceAdapter implements EvolveAdapter {
  readonly #score?: ModuleTraceAdapterOptions["score"];
  readonly #eventLimit: number;
  readonly #feedbackLimit: number;

  constructor(options?: ModuleTraceAdapterOptions) {
    this.#score = options?.score;
    this.#eventLimit = options?.eventLimit ?? 8;
    this.#feedbackLimit = options?.feedbackLimit ?? 4;
  }

  async loadExamples(options: {
    module: Module<z.ZodTypeAny, z.ZodTypeAny>;
    store: ModuleStore;
    modulePath: string;
    includeChildren?: boolean;
    limitPerModule?: number;
  }): Promise<EvolveExample[]> {
    const modulePaths = options.includeChildren
      ? options.module
          .getModuleEntries()
          .map((entry) => entry.path)
          .filter(
            (path) =>
              path === options.modulePath ||
              path.startsWith(`${options.modulePath}.`)
          )
      : [options.modulePath];

    const bundles: Array<{
      trace: ModuleTrace;
      events: ModuleTraceEvent[];
      feedback: ModuleFeedback[];
    }> = (
      await Promise.all(
        modulePaths.map(async (path) => {
          const traces = await options.store.getTraces(path, {
            limit: options.limitPerModule ?? 20
          });

          return Promise.all(
            traces.map((trace) =>
              options.store.getTraceBundle(trace.traceId, {
                eventLimit: this.#eventLimit,
                feedbackLimit: this.#feedbackLimit
              })
            )
          );
        })
      )
    )
      .flat()
      .filter((bundle): bundle is NonNullable<typeof bundle> => bundle != null)
      .sort((left, right) => left.trace.createdAt - right.trace.createdAt);

    return bundles.map((bundle) => this.toExample(bundle));
  }

  async evaluateCandidate(options: {
    module: Module<z.ZodTypeAny, z.ZodTypeAny>;
    store: ModuleStore;
    modulePath: string;
    candidate: EvolveCandidate;
    examples: EvolveExample[];
    context: ModuleContext;
  }): Promise<EvolveEvaluationResult> {
    const perExample = await Promise.all(
      options.examples.map(async (example) => {
        let output: unknown = undefined;
        let error: unknown = undefined;
        let traceId: string | undefined;

        try {
          const result = await options.module.invokeWithTrace(
            {
              ...options.context,
              store: options.store,
              artifacts: mergeArtifactOverlays(
                options.context.artifacts ?? {},
                materializeCandidateArtifacts(options.candidate)
              )
            },
            example.input as never
          );

          output = result.output;
          traceId = result.traceId;
        } catch (caught) {
          error = normalizeError(caught);
        }

        const score = await this.scoreExample({
          example,
          output,
          error,
          traceId
        });

        return {
          exampleId: example.exampleId,
          score,
          output,
          error,
          traceId
        } satisfies EvolveExampleScore;
      })
    );

    return {
      averageScore:
        perExample.length === 0
          ? 0
          : perExample.reduce((sum, entry) => sum + entry.score, 0) /
            perExample.length,
      perExample
    };
  }

  renderExample(example: EvolveExample): string {
    const parts = [
      `Example ${example.exampleId}`,
      `Input: ${truncateText(stableStringify(example.input), 600)}`
    ];

    if (example.baselineOutput != null) {
      parts.push(
        `Observed output: ${truncateText(
          stableStringify(example.baselineOutput),
          600
        )}`
      );
    }

    if (example.baselineError != null) {
      parts.push(
        `Observed error: ${truncateText(
          stableStringify(example.baselineError),
          400
        )}`
      );
    }

    if (example.asi.length > 0) {
      parts.push(
        `ASI: ${example.asi
          .slice(0, 3)
          .map((entry) => `${entry.kind}: ${truncateText(entry.message, 160)}`)
          .join(" | ")}`
      );
    }

    const latestFeedback = example.feedback[0];
    if (latestFeedback) {
      parts.push(
        `Feedback: ${stableStringify({
          score: latestFeedback.score,
          label: latestFeedback.label,
          comment: latestFeedback.comment
        })}`
      );
    }

    return parts.join("\n");
  }

  private toExample(bundle: {
    trace: ModuleTrace;
    events: ModuleTraceEvent[];
    feedback: ModuleFeedback[];
  }): EvolveExample {
    return {
      exampleId: bundle.trace.traceId,
      modulePath: bundle.trace.modulePath,
      traceId: bundle.trace.traceId,
      input: parseStoredJson(bundle.trace.inputJson),
      baselineOutput: parseStoredJson(bundle.trace.outputJson),
      baselineError: parseStoredJson(bundle.trace.errorJson),
      trace: bundle.trace,
      events: bundle.events,
      feedback: bundle.feedback.sort(
        (left, right) => right.createdAt - left.createdAt
      ),
      asi: bundle.events
        .filter((event) => event.visibility === "asi")
        .map((event) => ({
          kind: event.kind,
          level: event.level,
          message: event.message,
          payload: parseStoredJson(event.payloadJson)
        })),
      metadata: {
        latencyMs: bundle.trace.latencyMs,
        modelId: bundle.trace.modelId,
        adapterName: bundle.trace.adapterName,
        status: bundle.trace.status
      }
    };
  }

  private async scoreExample(options: {
    example: EvolveExample;
    output: unknown;
    error: unknown;
    traceId?: string;
  }): Promise<number> {
    if (this.#score) {
      return this.#score(options);
    }

    const latestFeedback = options.example.feedback.find(
      (entry) => entry.score != null
    );

    if (latestFeedback && options.example.baselineOutput != null) {
      return outputsMatch(options.output, options.example.baselineOutput)
        ? (latestFeedback.score ?? 0)
        : 0;
    }

    if (options.example.baselineOutput != null) {
      return outputsMatch(options.output, options.example.baselineOutput)
        ? 1
        : 0;
    }

    if (options.example.baselineError != null) {
      return options.error == null ? 1 : 0;
    }

    return options.error == null ? 1 : 0;
  }
}

export class EpochBatchSampler implements BatchSampler {
  readonly #examples: EvolveExample[];
  readonly #batchSize: number;
  readonly #random: () => number;
  #order: EvolveExample[];
  #index = 0;
  #epoch = 0;
  #minibatchIndex = 0;

  constructor(
    examples: EvolveExample[],
    batchSize: number,
    random: () => number = Math.random
  ) {
    this.#examples = [...examples];
    this.#batchSize = Math.max(
      1,
      Math.min(batchSize, this.#examples.length || 1)
    );
    this.#random = random;
    this.#order = shuffle([...this.#examples], this.#random);
  }

  nextBatch() {
    if (this.#examples.length === 0) {
      return {
        epoch: this.#epoch,
        minibatchIndex: this.#minibatchIndex,
        examples: []
      };
    }

    if (this.#index >= this.#order.length) {
      this.#epoch += 1;
      this.#minibatchIndex = 0;
      this.#index = 0;
      this.#order = shuffle([...this.#examples], this.#random);
    }

    const start = this.#index;
    const end = Math.min(this.#order.length, start + this.#batchSize);
    const examples = this.#order.slice(start, end);
    this.#index = end;
    const minibatchIndex = this.#minibatchIndex;
    this.#minibatchIndex += 1;

    return {
      epoch: this.#epoch,
      minibatchIndex,
      examples
    };
  }
}

export class ParetoCandidateSelector implements CandidateSelector {
  readonly #random: () => number;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  selectCandidate(options: {
    candidates: EvolveCandidate[];
    exampleIds: string[];
  }): EvolveCandidate {
    const candidates =
      options.candidates.length > 0 ? options.candidates : options.candidates;
    if (candidates.length === 0) {
      throw new Error(
        "ParetoCandidateSelector requires at least one candidate."
      );
    }

    const fronts = computeParetoFronts(candidates, options.exampleIds);
    const front = fronts[0] ?? candidates;
    return front[Math.floor(this.#random() * front.length)] ?? front[0];
  }
}

export class RoundRobinComponentSelector implements ComponentSelector {
  #index = 0;

  nextComponent(options: {
    components: EvolveTextComponent[];
  }): EvolveTextComponent {
    if (options.components.length === 0) {
      throw new Error(
        "RoundRobinComponentSelector requires at least one component."
      );
    }

    const component =
      options.components[this.#index % options.components.length];
    this.#index = (this.#index + 1) % options.components.length;
    return component;
  }
}

export class SqliteEvolveStore implements EvolveStore {
  #ready = false;

  constructor(private readonly sql: SqlFn) {
    this.ensureSchema();
  }

  async beginRun(run: EvolveRunState): Promise<void> {
    this.ensureSchema();
    this.sql`
      INSERT INTO evolve_runs (
        run_id, module_path, status, seed_candidate_id, best_candidate_id,
        seed_validation_score, best_validation_score, started_at, finished_at
      ) VALUES (
        ${run.runId}, ${run.modulePath}, ${"running"}, ${run.seedCandidateId},
        ${run.bestCandidateId}, ${null}, ${null}, ${run.startedAt}, ${null}
      )
    `;
  }

  async saveCandidate(
    runId: string,
    candidate: EvolveCandidate
  ): Promise<void> {
    this.ensureSchema();
    this.sql`
      INSERT OR REPLACE INTO evolve_candidates (
        candidate_id, run_id, parent_candidate_id, source, generation,
        component, minibatch_score, validation_score, accepted, promoted,
        created_at, payload_json
      ) VALUES (
        ${candidate.candidateId}, ${runId}, ${candidate.parentCandidateId},
        ${candidate.source}, ${candidate.generation}, ${candidate.component},
        ${candidate.minibatchScore}, ${candidate.validationScore},
        ${candidate.accepted ? 1 : 0}, ${candidate.promoted ? 1 : 0},
        ${candidate.createdAt}, ${JSON.stringify(candidate)}
      )
    `;
  }

  async finishRun(
    runId: string,
    update: {
      status: "completed" | "failed";
      bestCandidateId: string | null;
      seedValidationScore: number | null;
      bestValidationScore: number | null;
      finishedAt: number;
    }
  ): Promise<void> {
    this.ensureSchema();
    this.sql`
      UPDATE evolve_runs
      SET
        status = ${update.status},
        best_candidate_id = ${update.bestCandidateId},
        seed_validation_score = ${update.seedValidationScore},
        best_validation_score = ${update.bestValidationScore},
        finished_at = ${update.finishedAt}
      WHERE run_id = ${runId}
    `;
  }

  async listRuns(options?: {
    modulePath?: string;
    limit?: number;
  }): Promise<EvolveRunSummary[]> {
    this.ensureSchema();
    const limit = options?.limit ?? 25;

    if (options?.modulePath) {
      return this.sql`
        SELECT
          run_id as runId,
          module_path as modulePath,
          status,
          seed_candidate_id as seedCandidateId,
          best_candidate_id as bestCandidateId,
          seed_validation_score as seedValidationScore,
          best_validation_score as bestValidationScore,
          started_at as startedAt,
          finished_at as finishedAt
        FROM evolve_runs
        WHERE module_path = ${options.modulePath}
        ORDER BY started_at DESC
        LIMIT ${limit}
      ` as unknown as EvolveRunSummary[];
    }

    return this.sql`
      SELECT
        run_id as runId,
        module_path as modulePath,
        status,
        seed_candidate_id as seedCandidateId,
        best_candidate_id as bestCandidateId,
        seed_validation_score as seedValidationScore,
        best_validation_score as bestValidationScore,
        started_at as startedAt,
        finished_at as finishedAt
      FROM evolve_runs
      ORDER BY started_at DESC
      LIMIT ${limit}
    ` as unknown as EvolveRunSummary[];
  }

  async getCandidates(runId: string): Promise<EvolveCandidate[]> {
    this.ensureSchema();
    const rows = this.sql`
      SELECT payload_json as payloadJson
      FROM evolve_candidates
      WHERE run_id = ${runId}
      ORDER BY created_at ASC
    ` as Array<{ payloadJson: string }>;

    return rows
      .map((row) => {
        try {
          return JSON.parse(row.payloadJson) as EvolveCandidate;
        } catch {
          return null;
        }
      })
      .filter((candidate): candidate is EvolveCandidate => candidate != null);
  }

  private ensureSchema() {
    if (this.#ready) {
      return;
    }

    this.sql`
      CREATE TABLE IF NOT EXISTS evolve_runs (
        run_id TEXT PRIMARY KEY,
        module_path TEXT NOT NULL,
        status TEXT NOT NULL,
        seed_candidate_id TEXT,
        best_candidate_id TEXT,
        seed_validation_score REAL,
        best_validation_score REAL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS evolve_candidates (
        candidate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_candidate_id TEXT,
        source TEXT NOT NULL,
        generation INTEGER NOT NULL,
        component TEXT NOT NULL,
        minibatch_score REAL,
        validation_score REAL,
        accepted INTEGER NOT NULL,
        promoted INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_evolve_runs_module_started_at
      ON evolve_runs(module_path, started_at DESC)
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_evolve_candidates_run_created_at
      ON evolve_candidates(run_id, created_at ASC)
    `;

    this.#ready = true;
  }
}

export interface AgentEvolveHelpers {
  createModuleContext(
    context: Omit<ModuleContext, "store" | "emit"> & {
      emit?: (type: string, payload?: Record<string, unknown>) => void;
    }
  ): ModuleContext;
  saveTraceFeedback(options: {
    traceId: string;
    score?: number | null;
    label?: string | null;
    comment?: string | null;
  }): Promise<ModuleFeedback>;
  optimize(
    evolve: Evolve,
    options: Omit<EvolveOptimizeOptions, "store" | "evolveStore">
  ): Promise<EvolveRunResult>;
  listRuns(modulePath?: string, limit?: number): Promise<EvolveRunSummary[]>;
}

export function createAgentEvolveHelpers(options: {
  store: ModuleStore;
  evolveStore?: EvolveStore;
  emit?: (type: string, payload?: Record<string, unknown>) => void;
}): AgentEvolveHelpers {
  return {
    createModuleContext(context) {
      return {
        ...context,
        store: options.store,
        emit: (type, payload) => {
          options.emit?.(type, payload);
          context.emit?.(type, payload);
        }
      };
    },
    async saveTraceFeedback(input) {
      const feedback: ModuleFeedback = {
        id: crypto.randomUUID(),
        traceId: input.traceId,
        score: input.score ?? null,
        label: input.label ?? null,
        comment: input.comment ?? null,
        createdAt: Date.now()
      };

      await options.store.saveFeedback(feedback);
      return feedback;
    },
    async optimize(evolve, input) {
      return evolve.optimize({
        ...input,
        store: options.store,
        evolveStore: options.evolveStore
      });
    },
    async listRuns(modulePath, limit) {
      if (!options.evolveStore) {
        return [];
      }

      return options.evolveStore.listRuns({
        modulePath,
        limit
      });
    }
  };
}

export class Evolve {
  readonly #strategies: OptimizationStrategy[];
  readonly #generateTextFn: GenerateTextFn;

  constructor(options?: {
    strategies?: OptimizationStrategy[];
    generateText?: GenerateTextFn;
  }) {
    this.#generateTextFn = options?.generateText ?? generateText;
    this.#strategies = options?.strategies ?? [
      new TraceReviewStrategy({
        generateText: this.#generateTextFn
      })
    ];
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

  async optimize(options: EvolveOptimizeOptions): Promise<EvolveRunResult> {
    const modulePath = options.modulePath ?? options.module.getPath();
    const adapter = options.adapter ?? new ModuleTraceAdapter();
    const random = options.random ?? Math.random;
    const components = await loadTextComponents({
      module: options.module,
      store: options.store,
      modulePath,
      includeChildren: options.includeChildren
    });
    const seedParameters = buildSeedParameters(
      components,
      options.seedParameters,
      options.seedInstructions,
      modulePath
    );
    const examples = await adapter.loadExamples({
      module: options.module,
      store: options.store,
      modulePath,
      includeChildren: options.includeChildren,
      limitPerModule: options.limitPerModule
    });
    const [trainingExamples, validationExamples] = splitExamples(
      examples,
      options.validationSplit ?? 0.35
    );
    const batchSampler =
      options.batchSampler ??
      new EpochBatchSampler(
        trainingExamples.length > 0 ? trainingExamples : validationExamples,
        options.minibatchSize ?? 2,
        random
      );
    const candidateSelector =
      options.candidateSelector ?? new ParetoCandidateSelector(random);
    const componentSelector =
      options.componentSelector ?? new RoundRobinComponentSelector();
    const executionContext: ModuleContext = {
      ...(options.executionContext ?? {}),
      model: options.executionContext?.model ?? options.reflectionModel,
      store: options.store
    };
    const runId = crypto.randomUUID();
    const createdAt = Date.now();
    const seedCandidate: EvolveCandidate = {
      candidateId: crypto.randomUUID(),
      modulePath,
      instructions: getTopLevelInstructions(seedParameters, modulePath),
      parameters: seedParameters,
      source: "seed",
      generation: 0,
      component: getTopLevelInstructionComponentId(modulePath),
      componentLabel: `Instructions for ${modulePath}`,
      summary: "Seed candidate from the current text parameters.",
      rationale: [
        "Start the GEPA search from the module's currently active text parameters."
      ],
      parentCandidateId: null,
      mergedCandidateIds: [],
      createdAt,
      minibatchScore: null,
      validationScore: null,
      accepted: true,
      promoted: true,
      perExampleScores: {}
    };
    const run: EvolveRunState = {
      runId,
      modulePath,
      seedCandidateId: seedCandidate.candidateId,
      bestCandidateId: seedCandidate.candidateId,
      trainingExampleIds: trainingExamples.map((example) => example.exampleId),
      validationExampleIds: validationExamples.map(
        (example) => example.exampleId
      ),
      iteration: 0,
      epoch: 0,
      successes: 0,
      mergeAttempts: 0,
      startedAt: createdAt
    };

    await options.evolveStore?.beginRun(run);

    const candidates: EvolveCandidate[] = [seedCandidate];
    const acceptedCandidates: EvolveCandidate[] = [seedCandidate];
    const seedValidation = await this.evaluateAndRecordCandidate({
      adapter,
      candidate: seedCandidate,
      executionContext,
      examples:
        validationExamples.length > 0 ? validationExamples : trainingExamples,
      module: options.module,
      store: options.store
    });
    seedCandidate.validationScore = seedValidation.averageScore;
    await options.evolveStore?.saveCandidate(runId, seedCandidate);

    let bestCandidate = seedCandidate;
    let archive = buildArchiveEntries(
      acceptedCandidates,
      validationExamples.map((example) => example.exampleId)
    );

    const maxIterations = options.maxIterations ?? 4;
    const mergeEvery = Math.max(1, options.mergeEvery ?? 1);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const batch = batchSampler.nextBatch();
      run.iteration = iteration + 1;
      run.epoch = batch.epoch;

      if (batch.examples.length === 0) {
        break;
      }

      const parent = candidateSelector.selectCandidate({
        candidates: acceptedCandidates,
        exampleIds: batch.examples.map((example) => example.exampleId)
      });
      const component = componentSelector.nextComponent({
        components,
        iteration,
        candidates: acceptedCandidates
      });
      const parentBatch = await this.evaluateAndRecordCandidate({
        adapter,
        candidate: parent,
        executionContext,
        examples: batch.examples,
        module: options.module,
        store: options.store
      });

      const mutation = await this.generateMutation({
        reflectionModel: options.reflectionModel,
        module: options.module,
        modulePath,
        parent,
        component,
        components,
        batch,
        adapter
      });

      const nextText = normalizeInstructions(mutation.instructions);
      if (nextText === (parent.parameters[component.id] ?? null)) {
        continue;
      }

      const child: EvolveCandidate = {
        candidateId: crypto.randomUUID(),
        modulePath,
        instructions: getTopLevelInstructions(
          {
            ...parent.parameters,
            [component.id]: nextText ?? ""
          },
          modulePath
        ),
        parameters: {
          ...parent.parameters,
          [component.id]: nextText ?? ""
        },
        source: "mutation",
        generation: parent.generation + 1,
        component: component.id,
        componentLabel: component.label,
        summary: mutation.summary,
        rationale: mutation.rationale,
        parentCandidateId: parent.candidateId,
        mergedCandidateIds: [],
        createdAt: Date.now(),
        minibatchScore: null,
        validationScore: null,
        accepted: false,
        promoted: false,
        perExampleScores: {}
      };
      candidates.push(child);

      const childBatch = await this.evaluateAndRecordCandidate({
        adapter,
        candidate: child,
        executionContext,
        examples: batch.examples,
        module: options.module,
        store: options.store
      });
      child.accepted = isStrictImprovement(childBatch, parentBatch);
      await options.evolveStore?.saveCandidate(runId, child);

      if (!child.accepted) {
        continue;
      }

      run.successes += 1;
      child.promoted = true;
      acceptedCandidates.push(child);
      const validation = await this.evaluateAndRecordCandidate({
        adapter,
        candidate: child,
        executionContext,
        examples:
          validationExamples.length > 0 ? validationExamples : trainingExamples,
        module: options.module,
        store: options.store
      });
      child.validationScore = validation.averageScore;
      archive = buildArchiveEntries(
        acceptedCandidates,
        validationExamples.length > 0
          ? validationExamples.map((example) => example.exampleId)
          : trainingExamples.map((example) => example.exampleId)
      );

      if (
        child.validationScore != null &&
        (bestCandidate.validationScore == null ||
          child.validationScore > bestCandidate.validationScore)
      ) {
        bestCandidate = child;
        run.bestCandidateId = child.candidateId;
      }

      if (run.successes % mergeEvery !== 0 || acceptedCandidates.length < 2) {
        await options.evolveStore?.saveCandidate(runId, child);
        continue;
      }

      const mergePartner = selectMergePartner(
        bestCandidate,
        child,
        acceptedCandidates
      );
      if (!mergePartner) {
        await options.evolveStore?.saveCandidate(runId, child);
        continue;
      }

      run.mergeAttempts += 1;
      const mergedMutation = await this.generateMerge({
        reflectionModel: options.reflectionModel,
        module: options.module,
        modulePath,
        left: child,
        right: mergePartner,
        component,
        adapter,
        batch
      });

      const mergedText = normalizeInstructions(mergedMutation.instructions);
      if (
        mergedText === (child.parameters[component.id] ?? null) ||
        mergedText === (mergePartner.parameters[component.id] ?? null)
      ) {
        await options.evolveStore?.saveCandidate(runId, child);
        continue;
      }

      const merged: EvolveCandidate = {
        candidateId: crypto.randomUUID(),
        modulePath,
        instructions: getTopLevelInstructions(
          {
            ...child.parameters,
            [component.id]: mergedText ?? ""
          },
          modulePath
        ),
        parameters: {
          ...child.parameters,
          [component.id]: mergedText ?? ""
        },
        source: "merge",
        generation: Math.max(child.generation, mergePartner.generation) + 1,
        component: component.id,
        componentLabel: component.label,
        summary: mergedMutation.summary,
        rationale: mergedMutation.rationale,
        parentCandidateId: child.candidateId,
        mergedCandidateIds: [child.candidateId, mergePartner.candidateId],
        createdAt: Date.now(),
        minibatchScore: null,
        validationScore: null,
        accepted: false,
        promoted: false,
        perExampleScores: {}
      };
      candidates.push(merged);

      const bestParentBatch =
        parentBatch.averageScore >= childBatch.averageScore
          ? parentBatch
          : childBatch;
      const mergedBatch = await this.evaluateAndRecordCandidate({
        adapter,
        candidate: merged,
        executionContext,
        examples: batch.examples,
        module: options.module,
        store: options.store
      });
      merged.accepted = isStrictImprovement(mergedBatch, bestParentBatch);
      await options.evolveStore?.saveCandidate(runId, child);
      await options.evolveStore?.saveCandidate(runId, merged);

      if (!merged.accepted) {
        continue;
      }

      merged.promoted = true;
      acceptedCandidates.push(merged);
      const mergedValidation = await this.evaluateAndRecordCandidate({
        adapter,
        candidate: merged,
        executionContext,
        examples:
          validationExamples.length > 0 ? validationExamples : trainingExamples,
        module: options.module,
        store: options.store
      });
      merged.validationScore = mergedValidation.averageScore;
      archive = buildArchiveEntries(
        acceptedCandidates,
        validationExamples.length > 0
          ? validationExamples.map((example) => example.exampleId)
          : trainingExamples.map((example) => example.exampleId)
      );

      if (
        merged.validationScore != null &&
        (bestCandidate.validationScore == null ||
          merged.validationScore > bestCandidate.validationScore)
      ) {
        bestCandidate = merged;
        run.bestCandidateId = merged.candidateId;
      }
    }

    const appliedArtifacts: Partial<Record<ModuleArtifactType, string>> = {};
    const appliedArtifactsByModule: Record<
      string,
      Partial<Record<ModuleArtifactType, string>>
    > = {};
    const shouldActivate =
      (options.activate ?? false) &&
      stableStringify(bestCandidate.parameters) !==
        stableStringify(seedCandidate.parameters) &&
      (bestCandidate.validationScore ?? Number.NEGATIVE_INFINITY) >=
        (seedCandidate.validationScore ?? Number.NEGATIVE_INFINITY);

    if (shouldActivate) {
      const now = Date.now();
      const candidateArtifacts = materializeCandidateArtifacts(bestCandidate);
      const seedArtifacts = materializeCandidateArtifacts(seedCandidate);

      for (const [candidateModulePath, artifactSet] of Object.entries(
        candidateArtifacts
      )) {
        const seedArtifactSet = seedArtifacts[candidateModulePath] ?? {};

        for (const artifactType of [
          "instructions",
          "input-field-descriptions",
          "output-field-descriptions"
        ] satisfies ModuleArtifactType[]) {
          const nextValue = parseArtifactOverlayContent(
            artifactSet[artifactType]
          );
          const seedValue = parseArtifactOverlayContent(
            seedArtifactSet[artifactType]
          );

          if (stableStringify(nextValue) === stableStringify(seedValue)) {
            continue;
          }

          const artifactId = await saveArtifactIfPresent({
            store: options.store,
            modulePath: candidateModulePath,
            artifactType,
            value:
              nextValue != null &&
              typeof nextValue === "object" &&
              !Array.isArray(nextValue)
                ? (nextValue as Record<string, string>)
                : (nextValue as string | null),
            createdAt: now,
            activate: true,
            skipIfEmpty: artifactType !== "instructions"
          });

          if (!artifactId) {
            continue;
          }

          if (!appliedArtifactsByModule[candidateModulePath]) {
            appliedArtifactsByModule[candidateModulePath] = {};
          }
          appliedArtifactsByModule[candidateModulePath][artifactType] =
            artifactId;

          if (candidateModulePath === modulePath) {
            appliedArtifacts[artifactType] = artifactId;
          }
        }
      }

      bestCandidate.appliedArtifacts = appliedArtifacts;
      bestCandidate.appliedArtifactsByModule = appliedArtifactsByModule;
    }

    await options.evolveStore?.finishRun(runId, {
      status: "completed",
      bestCandidateId: bestCandidate.candidateId,
      seedValidationScore: seedCandidate.validationScore,
      bestValidationScore: bestCandidate.validationScore,
      finishedAt: Date.now()
    });

    return {
      run,
      seedCandidate,
      bestCandidate,
      candidates,
      archive,
      appliedArtifacts,
      appliedArtifactsByModule,
      trainingExamples,
      validationExamples
    };
  }

  private async evaluateAndRecordCandidate(options: {
    module: Module<z.ZodTypeAny, z.ZodTypeAny>;
    store: ModuleStore;
    candidate: EvolveCandidate;
    examples: EvolveExample[];
    adapter: EvolveAdapter;
    executionContext: ModuleContext;
  }): Promise<EvolveEvaluationBatch> {
    const evaluation = await options.adapter.evaluateCandidate({
      module: options.module,
      store: options.store,
      modulePath: options.candidate.modulePath,
      candidate: options.candidate,
      examples: options.examples,
      context: options.executionContext
    });

    for (const entry of evaluation.perExample) {
      options.candidate.perExampleScores[entry.exampleId] = entry.score;
    }

    if (options.examples.length > 0) {
      options.candidate.minibatchScore = evaluation.averageScore;
    }

    return {
      batchId: crypto.randomUUID(),
      epoch: 0,
      minibatchIndex: 0,
      exampleIds: options.examples.map((example) => example.exampleId),
      averageScore: evaluation.averageScore,
      perExample: evaluation.perExample
    };
  }

  private async generateMutation(options: {
    reflectionModel: LanguageModel;
    module: Module<z.ZodTypeAny, z.ZodTypeAny>;
    modulePath: string;
    parent: EvolveCandidate;
    component: EvolveTextComponent;
    components: EvolveTextComponent[];
    batch: {
      epoch: number;
      minibatchIndex: number;
      examples: EvolveExample[];
    };
    adapter: EvolveAdapter;
  }) {
    const prompt = buildMutationPrompt(options);
    const result = await this.#generateTextFn({
      model: options.reflectionModel,
      system: [
        "You are GEPA, a reflective prompt optimizer.",
        "Revise the target text component to improve replay performance on the supplied examples.",
        "Use ASI, validation failures, and feedback as actionable evidence.",
        "Return only improved text for the same component. Do not mention models, providers, or infrastructure."
      ].join("\n"),
      prompt,
      temperature: 0.2,
      maxOutputTokens: 900,
      output: Output.object({
        schema: mutationSchema,
        name: "gepa_mutation"
      })
    });

    return {
      summary: result.output.summary,
      instructions: normalizeInstructions(result.output.instructions),
      rationale: result.output.rationale
    };
  }

  private async generateMerge(options: {
    reflectionModel: LanguageModel;
    module: Module<z.ZodTypeAny, z.ZodTypeAny>;
    modulePath: string;
    left: EvolveCandidate;
    right: EvolveCandidate;
    component: EvolveTextComponent;
    adapter: EvolveAdapter;
    batch: {
      epoch: number;
      minibatchIndex: number;
      examples: EvolveExample[];
    };
  }) {
    const prompt = buildMergePrompt(options);
    const result = await this.#generateTextFn({
      model: options.reflectionModel,
      system: [
        "You are GEPA, merging two strong text candidates for the same component.",
        "Keep only the strongest actionable guidance and remove duplication.",
        "Output a single merged text value."
      ].join("\n"),
      prompt,
      temperature: 0.2,
      maxOutputTokens: 900,
      output: Output.object({
        schema: mutationSchema,
        name: "gepa_merge"
      })
    });

    return {
      summary: result.output.summary,
      instructions: normalizeInstructions(result.output.instructions),
      rationale: result.output.rationale
    };
  }
}

async function getCurrentInstructionText(
  store: ModuleStore,
  modulePath: string,
  base: string | null | undefined
): Promise<string | null> {
  const artifact = await store.getActiveArtifact(modulePath, "instructions");

  if (!artifact) {
    return normalizeInstructions(base ?? null);
  }

  try {
    return normalizeInstructions(
      JSON.parse(artifact.contentJson) as string | null
    );
  } catch {
    return normalizeInstructions(base ?? null);
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

async function loadTextComponents(options: {
  module: Module<z.ZodTypeAny, z.ZodTypeAny>;
  store: ModuleStore;
  modulePath: string;
  includeChildren?: boolean;
}): Promise<EvolveTextComponent[]> {
  const entries = options.module
    .getModuleEntries()
    .filter(
      (entry) =>
        entry.path === options.modulePath ||
        (options.includeChildren &&
          entry.path.startsWith(`${options.modulePath}.`))
    );
  const components: EvolveTextComponent[] = [];

  for (const entry of entries) {
    const currentInstructions = await getCurrentInstructionText(
      options.store,
      entry.path,
      entry.module.signature.instructions ?? null
    );
    if (currentInstructions != null) {
      components.push({
        id: getTopLevelInstructionComponentId(entry.path),
        modulePath: entry.path,
        artifactType: "instructions",
        fieldName: null,
        kind: "instructions",
        label: `Instructions for ${entry.path}`,
        currentValue: currentInstructions
      });
    }

    const inputFieldDescriptions = await getCurrentFieldDescriptions(
      options.store,
      entry.path,
      "input-field-descriptions",
      entry.module.signature.inputFieldDescriptions
    );
    const inputFieldNames = new Set([
      ...listSchemaFieldNames(entry.module.signature.input),
      ...Object.keys(inputFieldDescriptions)
    ]);
    for (const fieldName of [...inputFieldNames].sort()) {
      components.push({
        id: makeFieldComponentId(
          "input-field-description",
          entry.path,
          fieldName
        ),
        modulePath: entry.path,
        artifactType: "input-field-descriptions",
        fieldName,
        kind: "input-field-description",
        label: `Input field description for ${entry.path}.${fieldName}`,
        currentValue: inputFieldDescriptions[fieldName] ?? ""
      });
    }

    const outputFieldDescriptions = await getCurrentFieldDescriptions(
      options.store,
      entry.path,
      "output-field-descriptions",
      entry.module.signature.outputFieldDescriptions
    );
    const outputFieldNames = new Set([
      ...listSchemaFieldNames(entry.module.signature.output),
      ...Object.keys(outputFieldDescriptions)
    ]);
    for (const fieldName of [...outputFieldNames].sort()) {
      components.push({
        id: makeFieldComponentId(
          "output-field-description",
          entry.path,
          fieldName
        ),
        modulePath: entry.path,
        artifactType: "output-field-descriptions",
        fieldName,
        kind: "output-field-description",
        label: `Output field description for ${entry.path}.${fieldName}`,
        currentValue: outputFieldDescriptions[fieldName] ?? ""
      });
    }
  }

  return components;
}

function buildSeedParameters(
  components: EvolveTextComponent[],
  seedParameters: Record<string, string> | undefined,
  seedInstructions: string | null | undefined,
  modulePath: string
): Record<string, string> {
  const parameters: Record<string, string> = {};

  for (const component of components) {
    const seededValue =
      component.id === getTopLevelInstructionComponentId(modulePath) &&
      seedInstructions != null
        ? normalizeInstructions(seedInstructions)
        : (seedParameters?.[component.id] ?? component.currentValue);

    if (seededValue != null) {
      parameters[component.id] = seededValue;
    }
  }

  for (const [key, value] of Object.entries(seedParameters ?? {})) {
    if (!parameters[key] && value != null) {
      parameters[key] = value;
    }
  }

  return parameters;
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

function listSchemaFieldNames(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema.shape);
  }

  return [];
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

function buildMutationPrompt(options: {
  module: Module<z.ZodTypeAny, z.ZodTypeAny>;
  modulePath: string;
  parent: EvolveCandidate;
  component: EvolveTextComponent;
  components: EvolveTextComponent[];
  batch: {
    epoch: number;
    minibatchIndex: number;
    examples: EvolveExample[];
  };
  adapter: EvolveAdapter;
}): string {
  const targetModule =
    options.module
      .getModuleEntries()
      .find((entry) => entry.path === options.component.modulePath)?.module ??
    options.module;
  const currentInputFieldDescriptions = buildFieldDescriptionMap(
    options.parent.parameters,
    options.components,
    options.component.modulePath,
    "input-field-descriptions",
    targetModule.signature.inputFieldDescriptions
  );
  const currentOutputFieldDescriptions = buildFieldDescriptionMap(
    options.parent.parameters,
    options.components,
    options.component.modulePath,
    "output-field-descriptions",
    targetModule.signature.outputFieldDescriptions
  );
  const currentText = options.parent.parameters[options.component.id] ?? "";

  return [
    `Target module path: ${options.component.modulePath}`,
    `Target component: ${options.component.label}`,
    `Target component kind: ${options.component.kind}`,
    `Current target text:\n${currentText || "(none)"}`,
    `Current instructions for ${options.component.modulePath}:\n${
      options.parent.parameters[
        getTopLevelInstructionComponentId(options.component.modulePath)
      ] ?? "(none)"
    }`,
    `Current input field descriptions:\n${JSON.stringify(
      currentInputFieldDescriptions,
      null,
      2
    )}`,
    `Current output field descriptions:\n${JSON.stringify(
      currentOutputFieldDescriptions,
      null,
      2
    )}`,
    `Epoch: ${options.batch.epoch}`,
    `Minibatch index: ${options.batch.minibatchIndex}`,
    `Recent reflective dataset:\n${options.batch.examples
      .map((example) =>
        options.adapter.renderExample
          ? options.adapter.renderExample(example)
          : defaultRenderExample(example)
      )
      .join("\n\n")}`,
    options.component.kind === "instructions"
      ? "Write improved instructions for the target component. Keep the task unchanged."
      : "Write an improved field description for the target component. Keep it concise, concrete, and task-specific."
  ].join("\n\n");
}

function buildMergePrompt(options: {
  module: Module<z.ZodTypeAny, z.ZodTypeAny>;
  modulePath: string;
  left: EvolveCandidate;
  right: EvolveCandidate;
  component: EvolveTextComponent;
  adapter: EvolveAdapter;
  batch: {
    epoch: number;
    minibatchIndex: number;
    examples: EvolveExample[];
  };
}): string {
  return [
    `Target module path: ${options.component.modulePath}`,
    `Target component: ${options.component.label}`,
    `Candidate A text:\n${options.left.parameters[options.component.id] ?? "(none)"}`,
    `Candidate B text:\n${options.right.parameters[options.component.id] ?? "(none)"}`,
    `Reflective dataset:\n${options.batch.examples
      .map((example) =>
        options.adapter.renderExample
          ? options.adapter.renderExample(example)
          : defaultRenderExample(example)
      )
      .join("\n\n")}`,
    options.component.kind === "instructions"
      ? "Merge the strongest parts of both candidate instruction texts into a single improved version."
      : "Merge the strongest parts of both candidate field descriptions into a single improved version."
  ].join("\n\n");
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

function getTopLevelInstructionComponentId(modulePath: string): string {
  return `instructions:${modulePath}`;
}

function makeFieldComponentId(
  kind: "input-field-description" | "output-field-description",
  modulePath: string,
  fieldName: string
): string {
  return `${kind}:${modulePath}:${fieldName}`;
}

function getTopLevelInstructions(
  parameters: Record<string, string>,
  modulePath: string
): string | null {
  return normalizeInstructions(
    parameters[getTopLevelInstructionComponentId(modulePath)] ?? null
  );
}

function buildFieldDescriptionMap(
  parameters: Record<string, string>,
  components: EvolveTextComponent[],
  modulePath: string,
  artifactType: "input-field-descriptions" | "output-field-descriptions",
  base: Readonly<Record<string, string>>
): Record<string, string> {
  const merged = { ...base };

  for (const component of components) {
    if (
      component.modulePath !== modulePath ||
      component.artifactType !== artifactType ||
      component.fieldName == null
    ) {
      continue;
    }

    const value = parameters[component.id];
    if (typeof value === "string") {
      merged[component.fieldName] = value;
    }
  }

  return merged;
}

function materializeCandidateArtifacts(candidate: EvolveCandidate): Record<
  string,
  Partial<
    Record<
      ModuleArtifactType,
      {
        contentJson: string;
        version: string;
      }
    >
  >
> {
  const overlays: Record<
    string,
    Partial<
      Record<
        ModuleArtifactType,
        {
          contentJson: string;
          version: string;
        }
      >
    >
  > = {};

  for (const [componentId, value] of Object.entries(candidate.parameters)) {
    if (componentId.startsWith("instructions:")) {
      const modulePath = componentId.slice("instructions:".length);
      overlays[modulePath] ??= {};
      overlays[modulePath].instructions = {
        contentJson: JSON.stringify(normalizeInstructions(value)),
        version: `evolve-${candidate.candidateId}-${sanitizeVersionComponent(componentId)}`
      };
      continue;
    }

    const inputPrefix = "input-field-description:";
    if (componentId.startsWith(inputPrefix)) {
      const { modulePath, fieldName } = parseFieldComponentId(
        componentId,
        inputPrefix
      );
      overlays[modulePath] ??= {};
      const current = parseArtifactOverlayContent(
        overlays[modulePath]["input-field-descriptions"]
      ) as Record<string, string> | null;
      overlays[modulePath]["input-field-descriptions"] = {
        contentJson: JSON.stringify({
          ...(current ?? {}),
          [fieldName]: value
        }),
        version: `evolve-${candidate.candidateId}-${sanitizeVersionComponent(componentId)}`
      };
      continue;
    }

    const outputPrefix = "output-field-description:";
    if (componentId.startsWith(outputPrefix)) {
      const { modulePath, fieldName } = parseFieldComponentId(
        componentId,
        outputPrefix
      );
      overlays[modulePath] ??= {};
      const current = parseArtifactOverlayContent(
        overlays[modulePath]["output-field-descriptions"]
      ) as Record<string, string> | null;
      overlays[modulePath]["output-field-descriptions"] = {
        contentJson: JSON.stringify({
          ...(current ?? {}),
          [fieldName]: value
        }),
        version: `evolve-${candidate.candidateId}-${sanitizeVersionComponent(componentId)}`
      };
    }
  }

  return overlays;
}

function mergeArtifactOverlays(
  base: ModuleContext["artifacts"],
  incoming: ModuleContext["artifacts"]
): NonNullable<ModuleContext["artifacts"]> {
  const merged = {
    ...(base ?? {})
  };

  for (const [modulePath, artifactSet] of Object.entries(incoming ?? {})) {
    merged[modulePath] = {
      ...(merged[modulePath] ?? {}),
      ...artifactSet
    };
  }

  return merged;
}

function parseArtifactOverlayContent(
  artifact:
    | {
        contentJson: string;
      }
    | undefined
): unknown {
  if (!artifact) {
    return null;
  }

  try {
    return JSON.parse(artifact.contentJson);
  } catch {
    return null;
  }
}

function parseFieldComponentId(
  id: string,
  prefix: string
): {
  modulePath: string;
  fieldName: string;
} {
  const remainder = id.slice(prefix.length);
  const separatorIndex = remainder.lastIndexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Invalid field component id: ${id}`);
  }

  return {
    modulePath: remainder.slice(0, separatorIndex),
    fieldName: remainder.slice(separatorIndex + 1)
  };
}

function sanitizeVersionComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
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

function parseStoredJson(value: string | null): unknown {
  if (value == null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function defaultRenderExample(example: EvolveExample): string {
  return [
    `Input: ${truncateText(stableStringify(example.input), 600)}`,
    example.baselineOutput != null
      ? `Observed output: ${truncateText(
          stableStringify(example.baselineOutput),
          400
        )}`
      : undefined,
    example.baselineError != null
      ? `Observed error: ${truncateText(
          stableStringify(example.baselineError),
          300
        )}`
      : undefined,
    example.asi.length > 0
      ? `ASI: ${example.asi
          .slice(0, 3)
          .map((entry) => `${entry.kind}: ${truncateText(entry.message, 140)}`)
          .join(" | ")}`
      : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function splitExamples(
  examples: EvolveExample[],
  validationSplit: number
): [EvolveExample[], EvolveExample[]] {
  if (examples.length <= 1) {
    return [examples, examples];
  }

  const validationSize = Math.max(
    1,
    Math.min(examples.length - 1, Math.round(examples.length * validationSplit))
  );

  return [
    examples.slice(0, examples.length - validationSize),
    examples.slice(examples.length - validationSize)
  ];
}

function buildArchiveEntries(
  candidates: EvolveCandidate[],
  exampleIds: string[]
): EvolveArchiveEntry[] {
  const fronts = computeParetoFronts(candidates, exampleIds);

  return fronts.flatMap((front, rank) =>
    front.map((candidate) => ({
      candidateId: candidate.candidateId,
      validationScore: candidate.validationScore ?? Number.NEGATIVE_INFINITY,
      rank,
      dominates: candidates
        .filter((other) => dominates(candidate, other, exampleIds))
        .map((other) => other.candidateId)
    }))
  );
}

function computeParetoFronts(
  candidates: EvolveCandidate[],
  exampleIds: string[]
): EvolveCandidate[][] {
  if (candidates.length === 0) {
    return [];
  }

  const remaining = [...candidates];
  const fronts: EvolveCandidate[][] = [];

  while (remaining.length > 0) {
    const front = remaining.filter(
      (candidate) =>
        !remaining.some(
          (other) =>
            other.candidateId !== candidate.candidateId &&
            dominates(other, candidate, exampleIds)
        )
    );

    if (front.length === 0) {
      fronts.push([...remaining]);
      break;
    }

    fronts.push(
      front.sort(
        (left, right) =>
          (right.validationScore ?? Number.NEGATIVE_INFINITY) -
          (left.validationScore ?? Number.NEGATIVE_INFINITY)
      )
    );

    const frontIds = new Set(front.map((candidate) => candidate.candidateId));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (frontIds.has(remaining[index].candidateId)) {
        remaining.splice(index, 1);
      }
    }
  }

  return fronts;
}

function dominates(
  left: EvolveCandidate,
  right: EvolveCandidate,
  exampleIds: string[]
): boolean {
  const comparisons =
    exampleIds.length > 0
      ? exampleIds.map((exampleId) => [
          left.perExampleScores[exampleId] ?? Number.NEGATIVE_INFINITY,
          right.perExampleScores[exampleId] ?? Number.NEGATIVE_INFINITY
        ])
      : [
          [
            left.validationScore ?? Number.NEGATIVE_INFINITY,
            right.validationScore ?? Number.NEGATIVE_INFINITY
          ]
        ];

  const allAtLeastAsGood = comparisons.every(([lhs, rhs]) => lhs >= rhs);
  const anyStrictlyBetter = comparisons.some(([lhs, rhs]) => lhs > rhs);
  return allAtLeastAsGood && anyStrictlyBetter;
}

function isStrictImprovement(
  candidate: EvolveEvaluationResult,
  baseline: EvolveEvaluationResult
): boolean {
  if (candidate.perExample.length !== baseline.perExample.length) {
    return candidate.averageScore > baseline.averageScore;
  }

  const baselineById = new Map(
    baseline.perExample.map((entry) => [entry.exampleId, entry.score])
  );
  const allNonDegrading = candidate.perExample.every(
    (entry) =>
      entry.score >=
      (baselineById.get(entry.exampleId) ?? Number.NEGATIVE_INFINITY)
  );

  return allNonDegrading && candidate.averageScore > baseline.averageScore;
}

function selectMergePartner(
  bestCandidate: EvolveCandidate,
  child: EvolveCandidate,
  acceptedCandidates: EvolveCandidate[]
): EvolveCandidate | null {
  if (bestCandidate.candidateId !== child.candidateId) {
    return bestCandidate;
  }

  const other = [...acceptedCandidates]
    .reverse()
    .find((candidate) => candidate.candidateId !== child.candidateId);
  return other ?? null;
}

function normalizeInstructions(value: string | null): string | null {
  if (value == null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return error;
}

function outputsMatch(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)])
    );
  }

  return value;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(random() * (index + 1));
    [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
  }

  return items;
}
