import { generateText, type LanguageModel } from "ai";
import { Agent, callable, routeAgentRequest } from "agents";
import {
  Evolve,
  type EvolveAdapter,
  ModuleTraceAdapter,
  SqliteEvolveStore,
  createAgentEvolveHelpers,
  type EvolveArchiveEntry,
  type EvolveCandidate,
  type EvolveExample,
  type EvolveRunResult,
  type EvolveRunSummary,
  type EvolveTextComponent
} from "@cloudflare/evolve";
import {
  RLM,
  SqliteModuleStore,
  signature,
  type ModuleArtifactType,
  type ModuleContext,
  type ModuleFeedback,
  type ModuleStore,
  type ModuleTrace,
  type ModuleTraceEvent
} from "@cloudflare/modules";
import {
  createSubAgentQueryProvider,
  type RLMSubAgentQueryRequest
} from "@cloudflare/modules/agents";
import { createShellRLMRuntime } from "@cloudflare/modules/workers";
import { Workspace } from "@cloudflare/shell";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  RLM_BENCHMARK_FIXTURES,
  SAMPLE_DOSSIER,
  type RlmBenchmarkFixture
} from "./benchmark";

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  RLM_ARTIFACTS: R2Bucket;
  EvolveRlmAgent: DurableObjectNamespace<EvolveRlmAgent>;
};

const TASK_MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";
const REFLECTION_MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MODULE_PATH = "rlmWorkflow.investigateDossier";
const ACT_PATH = `${MODULE_PATH}.act`;
const EXTRACT_PATH = `${MODULE_PATH}.extract`;

const investigateDossierSignature = signature(MODULE_PATH)
  .withInput(
    z.object({
      question: z.string().min(1),
      dossier: z.string().min(1)
    })
  )
  .withOutput(
    z.object({
      answer: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
      approach: z.string(),
      evidence: z
        .array(
          z.object({
            path: z.string(),
            quote: z.string(),
            why: z.string()
          })
        )
        .min(2)
        .max(5)
    })
  )
  .describeInputField("question", "The dossier question to answer.")
  .describeInputField(
    "dossier",
    "A dossier or report to inspect through the shell-backed workspace."
  )
  .describeOutputField("answer", "A short answer.")
  .describeOutputField("confidence", "How certain the answer seems.")
  .describeOutputField("approach", "A brief note on what the model did.")
  .describeOutputField("evidence", "Supporting evidence items.")
  .withInstructions(`Answer quickly from the first plausible clue in the dossier.

Keep the response compact and avoid spending too much effort on cross-checking.
Prefer broad paraphrases over exact quoted support.`);

const QUERY_SYSTEM_PROMPT = `You are a narrow semantic helper for an RLM parent.

Answer only the scoped request you are given.
Do not assume missing context.
Be concise and concrete.`;

const ACT_BASELINE_INSTRUCTIONS = `Investigate the dossier through the shell-backed workspace before answering.

Write JavaScript or TypeScript only. The step executes inside an async function.

Runtime interface:
- Use the injected constant CONTEXT_ROOT for the workspace root path.
- Use state.* to inspect files under CONTEXT_ROOT.
- Use contextManifest and replHistory as prompt text only. They are not JavaScript variables inside the sandbox.
- Use scratch to keep small reusable notes across iterations.
- Use query/queryBatch only after you have inspected the relevant files or text snippets.
- If the dossier text is stored behind a "*.r2.txt" pointer, inspect the pointer first and then use the R2 helpers to read the underlying text.
- Log exactly what you inspected so later iterations can build on it.
- When you have verified the answer, call SUBMIT({ answer, confidence, approach, evidence }).

Avoid these failure modes:
- Do not reference bare names like contextRoot, contextManifest, dossierPointer, or question unless you created them in your code.
- Do not guess from high-level summaries when the dossier contains an exact figure or date.
- Do not submit until you have exact supporting evidence.`;

const EXTRACT_BASELINE_INSTRUCTIONS = `Produce the final structured answer from the RLM trajectory.

Use the replHistory, contextManifest, and any logged evidence to recover the best grounded answer.

Requirements:
- Prefer exact dates, figures, and quoted evidence over paraphrase.
- If the trajectory contains an exact answer, surface it directly.
- The approach should briefly describe which files or snippets were inspected.
- The evidence array should contain 2-5 concrete items with path, short quote, and why it supports the answer.
- Lower confidence when the trajectory is ambiguous or incomplete.`;

const ACT_INPUT_FIELD_DESCRIPTIONS: Record<string, string> = {
  contextRoot:
    "Absolute workspace root path. In generated code, use the injected constant CONTEXT_ROOT to access files under this directory.",
  contextManifest:
    "Prompt-visible summary of the context root, manifest path, and available resources. Read this before writing code. This is not a runtime JavaScript variable unless you copy it into one yourself.",
  replHistory:
    "Text transcript of prior iterations, including inspected files, logs, errors, and any previous SUBMIT attempts. Use it to avoid repeating mistakes.",
  iteration:
    "Current iteration marker in the form current/max. Use it to decide whether to keep exploring or finalize.",
  queryBudget:
    "Current semantic-query usage summary. Avoid wasting query/queryBatch calls before reading relevant files."
};

const ACT_OUTPUT_FIELD_DESCRIPTIONS: Record<string, string> = {
  reasoning:
    "Short planning note describing what the next code step will inspect or verify.",
  code: "JavaScript or TypeScript only. Use CONTEXT_ROOT plus state.* and the R2 helpers. Do not reference undeclared names like contextRoot or contextManifest."
};

const EXTRACT_INPUT_FIELD_DESCRIPTIONS: Record<string, string> = {
  contextRoot:
    "Absolute workspace root path for the dossier context. Mention relevant file paths from this root when summarizing evidence.",
  contextManifest:
    "Prompt-visible summary of the manifest and available resources. Use it to interpret file names and resource locations.",
  replHistory:
    "Full text transcript of the investigation, including logs, errors, and any candidate submissions. Extract the strongest grounded answer from it."
};

const EXTRACT_OUTPUT_FIELD_DESCRIPTIONS: Record<string, string> = {
  answer:
    "Direct answer to the dossier question with the exact date, figure, or recommendation when available.",
  approach:
    "One or two sentences summarizing what was inspected and how the answer was verified.",
  confidence:
    "low, medium, or high depending on how directly the dossier evidence supports the answer.",
  evidence:
    "Two to five evidence items with exact file path, short quote, and a why note tying each quote to the answer."
};

export type BenchmarkExampleView = {
  id: string;
  question: string;
  expectedSnippets: string[];
  focus: string;
};

export type TextSurfaceView = {
  componentId: string;
  modulePath: string;
  artifactType: ModuleArtifactType;
  fieldName: string | null;
  label: string;
  text: string;
  artifactId: string | null;
};

export type TraceExampleView = {
  fixtureId: string;
  question: string;
  expectedSnippets: string[];
  answer: string | null;
  confidence: string | null;
  approach: string | null;
  evidenceCount: number;
  score: number | null;
  traceId: string;
  status: ModuleTrace["status"];
  createdAt: number;
  asi: string[];
  feedbackComment: string | null;
};

export type CandidateView = {
  candidateId: string;
  source: EvolveCandidate["source"];
  generation: number;
  component: string;
  componentLabel: string;
  targetText: string | null;
  summary: string;
  instructions: string | null;
  minibatchScore: number | null;
  validationScore: number | null;
  accepted: boolean;
  promoted: boolean;
  rationale: string[];
  parentCandidateId: string | null;
  mergedCandidateIds: string[];
};

export type OptimizationRunView = {
  runId: string;
  startedAt: number;
  seedScore: number | null;
  bestScore: number | null;
  candidateCount: number;
  bestCandidateId: string;
  archive: EvolveArchiveEntry[];
  candidates: CandidateView[];
  appliedArtifacts: Array<{
    modulePath: string;
    artifactType: ModuleArtifactType;
    artifactId: string;
  }>;
};

export type OptimizationDashboard = {
  modulePath: string;
  benchmark: BenchmarkExampleView[];
  dossierLength: number;
  currentTexts: TextSurfaceView[];
  traceCount: number;
  feedbackCount: number;
  recentRuns: EvolveRunSummary[];
  latestRun: OptimizationRunView | null;
  latestExamples: TraceExampleView[];
};

type InvestigationOutput = z.infer<typeof investigateDossierSignature.output>;

class QueryAgent extends Agent<Env> {
  async query(input: RLMSubAgentQueryRequest): Promise<string> {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = await generateText({
      model: workersai(TASK_MODEL_ID, {
        sessionAffinity: this.sessionAffinity
      }),
      maxOutputTokens: 2048,
      system: QUERY_SYSTEM_PROMPT,
      prompt: formatQueryPrompt(input)
    });

    return result.text;
  }
}

class CuratedRlmComponentSelector {
  #index = 0;
  readonly #allowed = new Set<string>([
    `instructions:${ACT_PATH}`,
    `instructions:${EXTRACT_PATH}`,
    `input-field-description:${ACT_PATH}:contextRoot`,
    `input-field-description:${ACT_PATH}:contextManifest`,
    `input-field-description:${ACT_PATH}:replHistory`,
    `input-field-description:${ACT_PATH}:iteration`,
    `input-field-description:${ACT_PATH}:queryBudget`,
    `output-field-description:${ACT_PATH}:reasoning`,
    `output-field-description:${ACT_PATH}:code`,
    `input-field-description:${EXTRACT_PATH}:contextRoot`,
    `input-field-description:${EXTRACT_PATH}:contextManifest`,
    `input-field-description:${EXTRACT_PATH}:replHistory`,
    `output-field-description:${EXTRACT_PATH}:answer`,
    `output-field-description:${EXTRACT_PATH}:approach`,
    `output-field-description:${EXTRACT_PATH}:confidence`,
    `output-field-description:${EXTRACT_PATH}:evidence`
  ]);

  nextComponent(options: {
    components: EvolveTextComponent[];
  }): EvolveTextComponent {
    const filtered = options.components.filter((component) =>
      this.#allowed.has(component.id)
    );
    const candidates = filtered.length > 0 ? filtered : options.components;
    const component = candidates[this.#index % candidates.length];
    this.#index = (this.#index + 1) % candidates.length;
    return component;
  }
}

export class EvolveRlmAgent extends Agent<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "evolve_rlm",
    name: () => this.name
  });

  investigatorModule = new RLM(investigateDossierSignature, {
    runtime: createShellRLMRuntime({
      workspace: this.workspace,
      loader: this.env.LOADER,
      artifactBucket: this.env.RLM_ARTIFACTS,
      artifactPrefix: "evolve-rlm"
    }),
    queryProvider: createSubAgentQueryProvider({
      parent: this,
      childClass: QueryAgent
    }),
    maxIterations: 6,
    maxQueryCalls: 8,
    maxOutputChars: 8_000,
    verbose: true
  });

  evolve = new Evolve({
    generateText: generateReflectionObject as typeof generateText
  });

  @callable()
  async getDashboard(): Promise<OptimizationDashboard> {
    await this.ensureBaselineArtifacts();
    return this.buildDashboard();
  }

  @callable()
  async seedBenchmark(): Promise<OptimizationDashboard> {
    await this.ensureBaselineArtifacts();
    const store = this.getModuleStore();
    const helpers = this.getEvolveHelpers();

    for (const fixture of RLM_BENCHMARK_FIXTURES) {
      const run = await this.investigatorModule.invokeWithTrace(
        this.getModuleContext(),
        {
          question: fixture.question,
          dossier: SAMPLE_DOSSIER
        }
      );
      const score = scoreInvestigation(run.output, fixture);
      const correct = score >= 0.85;

      await store.appendTraceEvent({
        eventId: crypto.randomUUID(),
        traceId: run.traceId,
        seq: 1,
        visibility: "asi",
        kind: "benchmark_feedback",
        level: correct ? "info" : "warn",
        message: buildFeedbackMessage(run.output, fixture, score),
        payloadJson: JSON.stringify({
          fixtureId: fixture.id,
          expectedSnippets: fixture.expectedSnippets,
          score
        }),
        createdAt: Date.now()
      });

      await helpers.saveTraceFeedback({
        traceId: run.traceId,
        score,
        label: correct ? "correct" : score >= 0.4 ? "partial" : "incorrect",
        comment: JSON.stringify({
          fixtureId: fixture.id,
          expectedSnippets: fixture.expectedSnippets,
          diagnosis: fixture.diagnosis
        })
      });
    }

    return this.buildDashboard();
  }

  @callable()
  async optimizeBenchmark(): Promise<OptimizationDashboard> {
    await this.ensureBaselineArtifacts();
    const store = this.getModuleStore();
    const benchmarkFeedback = await store.getFeedback({
      modulePath: MODULE_PATH,
      limit: RLM_BENCHMARK_FIXTURES.length * 8
    });

    if (
      collectBenchmarkedFixtureIds(benchmarkFeedback).size <
      RLM_BENCHMARK_FIXTURES.length
    ) {
      await this.seedBenchmark();
    }

    const baseAdapter = new ModuleTraceAdapter({
      score: ({ example, output, error }) => {
        if (error != null) {
          return 0;
        }

        return scoreExampleFromFeedback(example, output);
      }
    });

    const benchmarkModule = this.investigatorModule;
    const adapter: EvolveAdapter = {
      async loadExamples() {
        const examples = await baseAdapter.loadExamples({
          module: benchmarkModule,
          store,
          modulePath: MODULE_PATH,
          includeChildren: false,
          limitPerModule: 48
        });

        return selectBenchmarkedExamples(examples);
      },
      evaluateCandidate: baseAdapter.evaluateCandidate.bind(baseAdapter),
      renderExample: baseAdapter.renderExample.bind(baseAdapter)
    };

    const result = await this.evolve.optimize({
      module: this.investigatorModule,
      store,
      evolveStore: this.getEvolveStore(),
      reflectionModel: this.getReflectionModel(),
      executionContext: {
        model: this.getTaskModel(),
        host: this,
        maxOutputTokens: 4096
      },
      adapter,
      activate: true,
      includeChildren: true,
      limitPerModule: 12,
      maxIterations: 4,
      minibatchSize: 2,
      validationSplit: 0.34,
      componentSelector: new CuratedRlmComponentSelector()
    });

    this.saveLatestResult(result);
    return this.buildDashboard();
  }

  @callable()
  async resetExperiment(): Promise<OptimizationDashboard> {
    this.clearExperimentTables();
    await this.ensureBaselineArtifacts();
    return this.buildDashboard();
  }

  private getTaskModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(TASK_MODEL_ID, {
      sessionAffinity: `${this.sessionAffinity}-task`
    });
  }

  private getReflectionModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(REFLECTION_MODEL_ID, {
      sessionAffinity: `${this.sessionAffinity}-reflection`
    });
  }

  private getModuleStore(): ModuleStore {
    return new SqliteModuleStore((strings, ...values) =>
      this.sql(strings, ...values)
    );
  }

  private getEvolveStore() {
    return new SqliteEvolveStore((strings, ...values) =>
      this.sql(strings, ...values)
    );
  }

  private getEvolveHelpers() {
    return createAgentEvolveHelpers({
      store: this.getModuleStore(),
      evolveStore: this.getEvolveStore()
    });
  }

  private getModuleContext(): ModuleContext {
    return this.getEvolveHelpers().createModuleContext({
      model: this.getTaskModel(),
      host: this,
      maxOutputTokens: 4096
    });
  }

  private async buildDashboard(): Promise<OptimizationDashboard> {
    const store = this.getModuleStore();
    const moduleEntries = this.investigatorModule
      .getModuleEntries()
      .filter(
        (entry) =>
          entry.path === MODULE_PATH || entry.path.startsWith(`${MODULE_PATH}.`)
      );
    const allTraces = (
      await Promise.all(
        moduleEntries.map((entry) =>
          store.getTraces(entry.path, {
            limit: 12
          })
        )
      )
    ).flat();
    const feedback = await store.getFeedback({
      modulePath: MODULE_PATH,
      limit: RLM_BENCHMARK_FIXTURES.length * 8
    });

    return {
      modulePath: MODULE_PATH,
      benchmark: RLM_BENCHMARK_FIXTURES.map((fixture) => ({
        id: fixture.id,
        question: fixture.question,
        expectedSnippets: [...fixture.expectedSnippets],
        focus: fixture.focus
      })),
      dossierLength: SAMPLE_DOSSIER.length,
      currentTexts: await this.buildCurrentTexts(),
      traceCount: allTraces.length,
      feedbackCount: feedback.length,
      recentRuns: await this.getEvolveStore().listRuns({
        modulePath: MODULE_PATH,
        limit: 8
      }),
      latestRun: this.getLatestResult(),
      latestExamples: await this.buildLatestExamples(
        allTraces.filter((trace) => trace.modulePath === MODULE_PATH)
      )
    };
  }

  private async ensureBaselineArtifacts(): Promise<void> {
    await Promise.all([
      this.ensureTextArtifact(
        ACT_PATH,
        "instructions",
        ACT_BASELINE_INSTRUCTIONS
      ),
      this.ensureTextArtifact(
        ACT_PATH,
        "input-field-descriptions",
        ACT_INPUT_FIELD_DESCRIPTIONS
      ),
      this.ensureTextArtifact(
        ACT_PATH,
        "output-field-descriptions",
        ACT_OUTPUT_FIELD_DESCRIPTIONS
      ),
      this.ensureTextArtifact(
        EXTRACT_PATH,
        "instructions",
        EXTRACT_BASELINE_INSTRUCTIONS
      ),
      this.ensureTextArtifact(
        EXTRACT_PATH,
        "input-field-descriptions",
        EXTRACT_INPUT_FIELD_DESCRIPTIONS
      ),
      this.ensureTextArtifact(
        EXTRACT_PATH,
        "output-field-descriptions",
        EXTRACT_OUTPUT_FIELD_DESCRIPTIONS
      )
    ]);
  }

  private async ensureTextArtifact(
    modulePath: string,
    artifactType: ModuleArtifactType,
    value: string | Record<string, string>
  ): Promise<void> {
    const store = this.getModuleStore();
    const activeArtifact = await store.getActiveArtifact(
      modulePath,
      artifactType
    );
    const currentValue =
      parseArtifactValue<string | Record<string, string>>(
        activeArtifact?.contentJson
      ) ?? null;

    if (hasMeaningfulArtifactValue(currentValue, value)) {
      return;
    }

    const artifactId = crypto.randomUUID();
    await store.saveArtifact({
      artifactId,
      modulePath,
      artifactType,
      version: `baseline-${artifactType}-${Date.now()}`,
      contentJson: JSON.stringify(value),
      createdAt: Date.now(),
      isActive: false
    });
    await store.activateArtifact(modulePath, artifactType, artifactId);
  }

  private async buildCurrentTexts(): Promise<TextSurfaceView[]> {
    const store = this.getModuleStore();
    const views: TextSurfaceView[] = [];

    for (const entry of this.investigatorModule.getModuleEntries()) {
      if (
        entry.path !== MODULE_PATH &&
        !entry.path.startsWith(`${MODULE_PATH}.`)
      ) {
        continue;
      }

      const instructionArtifact = await store.getActiveArtifact(
        entry.path,
        "instructions"
      );
      const instructionText =
        parseArtifactValue<string>(instructionArtifact?.contentJson) ??
        entry.module.signature.instructions ??
        "";
      if (instructionText) {
        views.push({
          componentId: `instructions:${entry.path}`,
          modulePath: entry.path,
          artifactType: "instructions",
          fieldName: null,
          label: `Instructions for ${entry.path}`,
          text: instructionText,
          artifactId: instructionArtifact?.artifactId ?? null
        });
      }

      const inputDescriptionsArtifact = await store.getActiveArtifact(
        entry.path,
        "input-field-descriptions"
      );
      const inputDescriptions = {
        ...entry.module.signature.inputFieldDescriptions,
        ...(parseArtifactValue<Record<string, string>>(
          inputDescriptionsArtifact?.contentJson
        ) ?? {})
      };
      for (const fieldName of [
        ...new Set([
          ...listSchemaFieldNames(entry.module.signature.input),
          ...Object.keys(inputDescriptions)
        ])
      ].sort()) {
        views.push({
          componentId: `input-field-description:${entry.path}:${fieldName}`,
          modulePath: entry.path,
          artifactType: "input-field-descriptions",
          fieldName,
          label: `Input field description for ${entry.path}.${fieldName}`,
          text: inputDescriptions[fieldName] ?? "",
          artifactId: inputDescriptionsArtifact?.artifactId ?? null
        });
      }

      const outputDescriptionsArtifact = await store.getActiveArtifact(
        entry.path,
        "output-field-descriptions"
      );
      const outputDescriptions = {
        ...entry.module.signature.outputFieldDescriptions,
        ...(parseArtifactValue<Record<string, string>>(
          outputDescriptionsArtifact?.contentJson
        ) ?? {})
      };
      for (const fieldName of [
        ...new Set([
          ...listSchemaFieldNames(entry.module.signature.output),
          ...Object.keys(outputDescriptions)
        ])
      ].sort()) {
        views.push({
          componentId: `output-field-description:${entry.path}:${fieldName}`,
          modulePath: entry.path,
          artifactType: "output-field-descriptions",
          fieldName,
          label: `Output field description for ${entry.path}.${fieldName}`,
          text: outputDescriptions[fieldName] ?? "",
          artifactId: outputDescriptionsArtifact?.artifactId ?? null
        });
      }
    }

    return views;
  }

  private async buildLatestExamples(
    traces: ModuleTrace[]
  ): Promise<TraceExampleView[]> {
    const bundles = (
      await Promise.all(
        traces.map((trace) =>
          this.getModuleStore().getTraceBundle(trace.traceId)
        )
      )
    ).filter(
      (
        bundle
      ): bundle is NonNullable<
        Awaited<ReturnType<ModuleStore["getTraceBundle"]>>
      > => bundle != null
    );

    return Promise.all(
      RLM_BENCHMARK_FIXTURES.map(async (fixture) => {
        const bundle = selectLatestBundleForFixture(bundles, fixture);
        if (!bundle) {
          return {
            fixtureId: fixture.id,
            question: fixture.question,
            expectedSnippets: [...fixture.expectedSnippets],
            answer: null,
            confidence: null,
            approach: null,
            evidenceCount: 0,
            score: null,
            traceId: "",
            status: "running",
            createdAt: 0,
            asi: [],
            feedbackComment: null
          };
        }

        const output = parseArtifactValue<InvestigationOutput>(
          bundle.trace.outputJson
        );
        const latestFeedback = bundle?.feedback[0] ?? null;
        return {
          fixtureId: fixture.id,
          question: fixture.question,
          expectedSnippets: [...fixture.expectedSnippets],
          answer: output?.answer ?? null,
          confidence: output?.confidence ?? null,
          approach: output?.approach ?? null,
          evidenceCount: output?.evidence?.length ?? 0,
          score:
            latestFeedback?.score ??
            (output ? scoreInvestigation(output, fixture) : null),
          traceId: bundle.trace.traceId,
          status: bundle.trace.status,
          createdAt: bundle.trace.createdAt,
          asi:
            bundle?.events
              .filter((event) => event.visibility === "asi")
              .map((event) => event.message) ?? [],
          feedbackComment: latestFeedback?.comment ?? null
        };
      })
    );
  }

  private ensureLatestResultTable() {
    this.sql`
      CREATE TABLE IF NOT EXISTS evolve_experiment_results (
        slot TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
  }

  private saveLatestResult(result: EvolveRunResult) {
    this.ensureLatestResultTable();
    const payload = JSON.stringify({
      runId: result.run.runId,
      startedAt: result.run.startedAt,
      seedScore: result.seedCandidate.validationScore,
      bestScore: result.bestCandidate.validationScore,
      candidateCount: result.candidates.length,
      bestCandidateId: result.bestCandidate.candidateId,
      archive: result.archive,
      candidates: result.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        source: candidate.source,
        generation: candidate.generation,
        component: candidate.component,
        componentLabel: candidate.componentLabel,
        targetText: candidate.parameters[candidate.component] ?? null,
        summary: candidate.summary,
        instructions: candidate.instructions,
        minibatchScore: candidate.minibatchScore,
        validationScore: candidate.validationScore,
        accepted: candidate.accepted,
        promoted: candidate.promoted,
        rationale: candidate.rationale,
        parentCandidateId: candidate.parentCandidateId,
        mergedCandidateIds: candidate.mergedCandidateIds
      })),
      appliedArtifacts: Object.entries(result.appliedArtifactsByModule).flatMap(
        ([modulePath, artifactSet]) =>
          Object.entries(artifactSet).map(([artifactType, artifactId]) => ({
            modulePath,
            artifactType: artifactType as ModuleArtifactType,
            artifactId: artifactId as string
          }))
      )
    } satisfies OptimizationRunView);

    this.sql`
      INSERT OR REPLACE INTO evolve_experiment_results (
        slot,
        payload_json,
        created_at
      ) VALUES (
        ${"latest"},
        ${payload},
        ${Date.now()}
      )
    `;
  }

  private getLatestResult(): OptimizationRunView | null {
    this.ensureLatestResultTable();
    const row = this.sql<{ payloadJson: string }>`
      SELECT payload_json as payloadJson
      FROM evolve_experiment_results
      WHERE slot = ${"latest"}
      LIMIT 1
    `[0];

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.payloadJson) as OptimizationRunView;
    } catch {
      return null;
    }
  }

  private clearExperimentTables() {
    this.ensureLatestResultTable();
    this.sql`DELETE FROM module_trace_events`;
    this.sql`DELETE FROM module_feedback`;
    this.sql`DELETE FROM module_artifacts`;
    this.sql`DELETE FROM module_traces`;
    this.sql`DELETE FROM evolve_candidates`;
    this.sql`DELETE FROM evolve_runs`;
    this.sql`DELETE FROM evolve_experiment_results`;
  }
}

function buildFeedbackMessage(
  output: InvestigationOutput,
  fixture: RlmBenchmarkFixture,
  score: number
): string {
  const answer = normalizeText(output.answer);
  const missing = fixture.expectedSnippets.filter(
    (snippet) => !answer.includes(normalizeText(snippet))
  );

  if (score >= 0.85) {
    return `Matched the benchmark target for ${fixture.id} with grounded evidence.`;
  }

  if (missing.length === fixture.expectedSnippets.length) {
    return `The answer missed the key target ${fixture.expectedSnippets.join(" / ")}. Inspect the dossier more carefully and quote exact support.`;
  }

  return `The answer was partially correct, but it needs tighter evidence and explicit mention of ${missing.join(" / ")}.`;
}

function scoreExampleFromFeedback(
  example: EvolveExample,
  output: unknown
): number {
  if (example.modulePath !== MODULE_PATH) {
    return 1;
  }

  const feedback = parseArtifactValue<{
    expectedSnippets?: string[];
    diagnosis?: string;
  }>(example.feedback[0]?.comment);
  const investigation = output as
    | Partial<InvestigationOutput>
    | null
    | undefined;
  const answer = normalizeText(investigation?.answer ?? "");
  const quotes = (investigation?.evidence ?? [])
    .map((entry) => normalizeText(entry.quote))
    .join(" ");
  const expectedSnippets = feedback?.expectedSnippets ?? [];

  if (expectedSnippets.length === 0) {
    return 0;
  }

  const answerHit = expectedSnippets.some((snippet) =>
    answer.includes(normalizeText(snippet))
  );
  const quoteHit = expectedSnippets.some((snippet) =>
    quotes.includes(normalizeText(snippet))
  );
  const evidenceCountHit = (investigation?.evidence?.length ?? 0) >= 2;

  return Number(
    (answerHit ? 0.6 : 0) +
      (quoteHit ? 0.25 : 0) +
      (evidenceCountHit ? 0.15 : 0)
  );
}

function scoreInvestigation(
  output: InvestigationOutput,
  fixture: RlmBenchmarkFixture
): number {
  const answer = normalizeText(output.answer);
  const quotes = output.evidence
    .map((entry) => normalizeText(entry.quote))
    .join(" ");
  const answerHit = fixture.expectedSnippets.some((snippet) =>
    answer.includes(normalizeText(snippet))
  );
  const quoteHit = fixture.expectedSnippets.some((snippet) =>
    quotes.includes(normalizeText(snippet))
  );
  const evidenceCountHit = output.evidence.length >= 2;

  return Number(
    (answerHit ? 0.6 : 0) +
      (quoteHit ? 0.25 : 0) +
      (evidenceCountHit ? 0.15 : 0)
  );
}

function listSchemaFieldNames(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema.shape);
  }

  return [];
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseArtifactValue<T>(value: string | null | undefined): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function hasMeaningfulArtifactValue(
  currentValue: string | Record<string, string> | null,
  nextValue: string | Record<string, string>
): boolean {
  if (typeof nextValue === "string") {
    return typeof currentValue === "string" && currentValue.trim().length > 0;
  }

  if (
    currentValue == null ||
    typeof currentValue !== "object" ||
    Array.isArray(currentValue)
  ) {
    return false;
  }

  return Object.entries(nextValue).every(([key, value]) =>
    typeof currentValue[key] === "string" &&
    currentValue[key].trim().length > 0 &&
    currentValue[key].trim() !== value.trim()
      ? true
      : typeof currentValue[key] === "string" &&
        currentValue[key].trim().length > 0
  );
}

function parseBenchmarkFeedbackComment(comment: string | null | undefined): {
  fixtureId?: string;
  expectedSnippets?: string[];
  diagnosis?: string;
} | null {
  return parseArtifactValue<{
    fixtureId?: string;
    expectedSnippets?: string[];
    diagnosis?: string;
  }>(comment);
}

function collectBenchmarkedFixtureIds(feedback: ModuleFeedback[]): Set<string> {
  const fixtureIds = new Set<string>();

  for (const entry of feedback) {
    const parsed = parseBenchmarkFeedbackComment(entry.comment);
    if (parsed?.fixtureId) {
      fixtureIds.add(parsed.fixtureId);
    }
  }

  return fixtureIds;
}

function selectBenchmarkedExamples(examples: EvolveExample[]): EvolveExample[] {
  const latestByFixture = new Map<string, EvolveExample>();

  for (const example of [...examples].sort(compareExamplesNewestFirst)) {
    const parsed = parseBenchmarkFeedbackComment(example.feedback[0]?.comment);
    if (!parsed?.fixtureId || latestByFixture.has(parsed.fixtureId)) {
      continue;
    }
    latestByFixture.set(parsed.fixtureId, example);
  }

  return RLM_BENCHMARK_FIXTURES.map((fixture) =>
    latestByFixture.get(fixture.id)
  ).filter((example): example is EvolveExample => example != null);
}

function compareExamplesNewestFirst(
  left: EvolveExample,
  right: EvolveExample
): number {
  return (right.trace?.createdAt ?? 0) - (left.trace?.createdAt ?? 0);
}

function selectLatestBundleForFixture(
  bundles: Array<
    NonNullable<Awaited<ReturnType<ModuleStore["getTraceBundle"]>>>
  >,
  fixture: RlmBenchmarkFixture
) {
  const matching = bundles
    .filter((bundle) => {
      const input = parseArtifactValue<{ question?: string }>(
        bundle.trace.inputJson
      );
      return input?.question === fixture.question;
    })
    .sort((left, right) => right.trace.createdAt - left.trace.createdAt);

  const withFeedback = matching.find((bundle) =>
    bundle.feedback.some(
      (entry) =>
        parseBenchmarkFeedbackComment(entry.comment)?.fixtureId === fixture.id
    )
  );

  return withFeedback ?? matching[0] ?? null;
}

function formatQueryPrompt(input: RLMSubAgentQueryRequest): string {
  const parts = [`Prompt:\n${input.prompt}`];

  if (input.options?.label) {
    parts.push(`Label: ${input.options.label}`);
  }

  if (input.options?.metadata) {
    parts.push(`Metadata:\n${JSON.stringify(input.options.metadata, null, 2)}`);
  }

  return parts.join("\n\n");
}

async function generateReflectionObject(options: {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
}) {
  const response = await generateText({
    model: options.model,
    system: [
      options.system,
      "Return strict JSON with keys: summary, instructions, rationale."
    ]
      .filter(Boolean)
      .join("\n\n"),
    prompt: options.prompt ?? "",
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens ?? 900
  });

  const json = extractFirstJsonObject(response.text);
  const parsed = parseReflectionJson(json);
  const instructions =
    parsed?.instructions?.trim() ||
    "Inspect the dossier thoroughly, verify concrete claims, and quote exact evidence.";
  const rationale = Array.isArray(parsed?.rationale)
    ? parsed.rationale.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0
      )
    : typeof parsed?.rationale === "string" && parsed.rationale.length > 0
      ? [parsed.rationale]
      : [];

  return {
    output: {
      summary:
        parsed?.summary?.trim() || "Reflection-generated RLM text update.",
      instructions,
      rationale:
        rationale.length > 0
          ? rationale
          : [
              "The benchmark feedback indicates the RLM should inspect more carefully and quote exact support."
            ]
    }
  };
}

function extractFirstJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1);
}

function parseReflectionJson(json: string | null): {
  summary?: string;
  instructions?: string;
  rationale?: string[] | string;
} | null {
  if (!json) {
    return null;
  }

  try {
    return JSON.parse(json) as {
      summary?: string;
      instructions?: string;
      rationale?: string[] | string;
    };
  } catch {
    try {
      return JSON.parse(escapeControlCharsInJsonString(json)) as {
        summary?: string;
        instructions?: string;
        rationale?: string[] | string;
      };
    } catch {
      return null;
    }
  }
}

function escapeControlCharsInJsonString(value: string): string {
  let out = "";
  let inString = false;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      out += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      out += char;
      escaping = true;
      continue;
    }

    if (char === '"') {
      out += char;
      inString = !inString;
      continue;
    }

    if (!inString) {
      out += char;
      continue;
    }

    switch (char) {
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        if (char < " ") {
          out += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        } else {
          out += char;
        }
    }
  }

  return out;
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
