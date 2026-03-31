import { generateText, type LanguageModel } from "ai";
import { callable, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import {
  Predict,
  SqliteModuleStore,
  signature,
  type ModuleArtifact,
  type ModuleContext,
  type ModuleFeedback,
  type ModuleStore,
  type ModuleTrace,
  type ModuleTraceEvent,
  type PredictAdapter
} from "@cloudflare/modules";
import {
  Evolve,
  ModuleTraceAdapter,
  SqliteEvolveStore,
  createAgentEvolveHelpers,
  type EvolveArchiveEntry,
  type EvolveCandidate,
  type EvolveRunResult,
  type EvolveRunSummary
} from "@cloudflare/evolve";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { BENCHMARK_FIXTURES, type BenchmarkFixture } from "./benchmark";

type Env = {
  AI: Ai;
  EvolveExampleAgent: DurableObjectNamespace<EvolveExampleAgent>;
};

const TASK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const REFLECTION_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODULE_PATH = "benchmark.solve";

const benchmarkSignature = signature(MODULE_PATH)
  .withInput(
    z.object({
      problem: z.string().min(1)
    })
  )
  .withOutput(
    z.object({
      answer: z.string().min(1)
    })
  )
  .describeInputField(
    "problem",
    "A short arithmetic question from the benchmark fixture set."
  )
  .describeOutputField("answer", "The exact numeric answer as a string.")
  .withInstructions(
    'Solve the problem, but always put "0" in the answer field.'
  );

export type TraceExampleView = {
  fixtureId: string;
  problem: string;
  expectedAnswer: string;
  actualAnswer: string | null;
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
  appliedArtifactId: string | null;
};

export type OptimizationDashboard = {
  modulePath: string;
  benchmark: BenchmarkFixture[];
  currentInstructions: string | null;
  activeArtifactId: string | null;
  traceCount: number;
  feedbackCount: number;
  recentRuns: EvolveRunSummary[];
  latestRun: OptimizationRunView | null;
  latestExamples: TraceExampleView[];
};

class PlainTextMathAdapter implements PredictAdapter {
  readonly name = "workers-ai-plain-text";

  async execute<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    context: ModuleContext & {
      trace: {
        setMetadata(metadata: Record<string, string | null>): void;
      };
    },
    signatureShape: {
      instructions?: string;
    },
    input: z.output<I>
  ) {
    const result = await generateText({
      model: context.model,
      system: [
        signatureShape.instructions,
        "Return only the exact numeric answer. Do not return JSON."
      ]
        .filter(Boolean)
        .join("\n\n"),
      prompt: `Problem: ${
        typeof input === "object" && input && "problem" in input
          ? String((input as { problem?: unknown }).problem ?? "")
          : ""
      }`,
      maxOutputTokens: context.maxOutputTokens ?? 64,
      temperature: 0
    });

    const answer = normalizeAnswer(result.text) || result.text.trim() || "0";
    const usageJson =
      result.usage == null ? null : JSON.stringify(result.usage);
    context.trace.setMetadata({
      modelId: TASK_MODEL_ID,
      adapterName: this.name,
      usageJson
    });

    return {
      output: {
        answer
      } as z.output<O>,
      metadata: {
        modelId: TASK_MODEL_ID,
        adapterName: this.name,
        usageJson
      }
    };
  }
}

export class EvolveExampleAgent extends Think<Env> {
  benchmarkModule = new Predict(benchmarkSignature, {
    adapter: new PlainTextMathAdapter()
  });
  evolve = new Evolve({
    generateText: generateReflectionObject as typeof generateText
  });

  override getModel(): LanguageModel {
    return this.getTaskModel();
  }

  override getSystemPrompt(): string {
    return "You host the experimental GEPA workbench.";
  }

  @callable()
  async getDashboard(): Promise<OptimizationDashboard> {
    return this.buildDashboard();
  }

  @callable()
  async seedBenchmark(): Promise<OptimizationDashboard> {
    const store = this.getModuleStore();
    const helpers = this.getEvolveHelpers();

    for (const fixture of BENCHMARK_FIXTURES) {
      const run = await this.benchmarkModule.invokeWithTrace(
        this.getModuleContext(),
        {
          problem: fixture.problem
        }
      );
      const actualAnswer = normalizeAnswer(run.output.answer);
      const correct = actualAnswer === fixture.expectedAnswer;

      await store.appendTraceEvent({
        eventId: crypto.randomUUID(),
        traceId: run.traceId,
        seq: 1,
        visibility: "asi",
        kind: "benchmark_feedback",
        level: correct ? "info" : "warn",
        message: correct
          ? `Matched the expected answer ${fixture.expectedAnswer}.`
          : `Expected ${fixture.expectedAnswer}, but the current instructions produced ${actualAnswer || "(blank)"}. Remove any rule that forces 0 and return the exact numeric answer.`,
        payloadJson: JSON.stringify({
          fixtureId: fixture.id,
          expectedAnswer: fixture.expectedAnswer,
          actualAnswer
        }),
        createdAt: Date.now()
      });

      await helpers.saveTraceFeedback({
        traceId: run.traceId,
        score: correct ? 1 : 0,
        label: correct ? "correct" : "incorrect",
        comment: JSON.stringify({
          fixtureId: fixture.id,
          expectedAnswer: fixture.expectedAnswer,
          actualAnswer,
          diagnosis:
            'The instruction "always put 0 in the answer field" must be removed. Return the exact numeric answer.'
        })
      });
    }

    return this.buildDashboard();
  }

  @callable()
  async optimizeBenchmark(): Promise<OptimizationDashboard> {
    const store = this.getModuleStore();
    const traces = await store.getTraces(MODULE_PATH, {
      limit: 1
    });

    if (traces.length === 0) {
      await this.seedBenchmark();
    }

    const result = await this.evolve.optimize({
      module: this.benchmarkModule,
      store,
      evolveStore: this.getEvolveStore(),
      reflectionModel: this.getReflectionModel(),
      executionContext: {
        model: this.getTaskModel(),
        host: this,
        maxOutputTokens: 128
      },
      adapter: new ModuleTraceAdapter({
        score: ({ example, output }) => {
          const expected = parseFeedbackComment(example.feedback[0]);
          const answer =
            output != null &&
            typeof output === "object" &&
            "answer" in output &&
            typeof (output as { answer?: unknown }).answer === "string"
              ? normalizeAnswer((output as { answer: string }).answer)
              : "";

          return answer === expected.expectedAnswer ? 1 : 0;
        }
      }),
      activate: true,
      limitPerModule: 24,
      maxIterations: 3,
      minibatchSize: 2,
      validationSplit: 0.34
    });

    this.saveLatestResult(result);
    return this.buildDashboard();
  }

  @callable()
  async resetExperiment(): Promise<OptimizationDashboard> {
    this.clearExperimentTables();
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
      maxOutputTokens: 128
    });
  }

  private async buildDashboard(): Promise<OptimizationDashboard> {
    const store = this.getModuleStore();
    const activeInstructionsArtifact = this.sql<{
      artifactId: string;
      contentJson: string;
    }>`
      SELECT artifact_id as artifactId, content_json as contentJson
      FROM module_artifacts
      WHERE module_path = ${MODULE_PATH}
        AND artifact_type = ${"instructions"}
        AND is_active = 1
      ORDER BY created_at DESC
      LIMIT 1
    `[0];
    const traces = await store.getTraces(MODULE_PATH, {
      limit: 24
    });
    const feedback = await store.getFeedback({
      modulePath: MODULE_PATH,
      limit: 24
    });
    const recentRuns = await this.getEvolveStore().listRuns({
      modulePath: MODULE_PATH,
      limit: 8
    });
    const latestResult = this.getLatestResult();

    return {
      modulePath: MODULE_PATH,
      benchmark: [...BENCHMARK_FIXTURES],
      currentInstructions:
        parseArtifactValue<string>(activeInstructionsArtifact?.contentJson) ??
        this.benchmarkModule.signature.instructions ??
        null,
      activeArtifactId: activeInstructionsArtifact?.artifactId ?? null,
      traceCount: traces.length,
      feedbackCount: feedback.length,
      recentRuns,
      latestRun: latestResult,
      latestExamples: await this.buildLatestExamples(traces)
    };
  }

  private async buildLatestExamples(
    traces: ModuleTrace[]
  ): Promise<TraceExampleView[]> {
    const latestByProblem = new Map<string, ModuleTrace>();

    for (const trace of [...traces].sort(
      (left, right) => right.createdAt - left.createdAt
    )) {
      const input = parseArtifactValue<{ problem?: string }>(trace.inputJson);
      const problem = input?.problem;
      if (!problem || latestByProblem.has(problem)) {
        continue;
      }
      latestByProblem.set(problem, trace);
    }

    return Promise.all(
      BENCHMARK_FIXTURES.map(async (fixture) => {
        const trace = latestByProblem.get(fixture.problem);
        if (!trace) {
          return {
            fixtureId: fixture.id,
            problem: fixture.problem,
            expectedAnswer: fixture.expectedAnswer,
            actualAnswer: null,
            score: null,
            traceId: "",
            status: "running",
            createdAt: 0,
            asi: [],
            feedbackComment: null
          };
        }

        const bundle = await this.getModuleStore().getTraceBundle(
          trace.traceId
        );
        const output = parseArtifactValue<{ answer?: string }>(
          trace.outputJson
        );
        const latestFeedback = bundle?.feedback[0] ?? null;
        return {
          fixtureId: fixture.id,
          problem: fixture.problem,
          expectedAnswer: fixture.expectedAnswer,
          actualAnswer:
            typeof output?.answer === "string"
              ? normalizeAnswer(output.answer)
              : null,
          score: latestFeedback?.score ?? null,
          traceId: trace.traceId,
          status: trace.status,
          createdAt: trace.createdAt,
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
      appliedArtifactId: result.appliedArtifacts.instructions ?? null
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

function normalizeAnswer(value: string): string {
  return value.trim().replace(/[^\d-]/g, "");
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

function parseFeedbackComment(feedback: ModuleFeedback | undefined | null): {
  expectedAnswer: string;
} {
  const parsed = parseArtifactValue<{ expectedAnswer?: string }>(
    feedback?.comment
  );
  return {
    expectedAnswer: parsed?.expectedAnswer ?? ""
  };
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
    maxOutputTokens: options.maxOutputTokens ?? 700
  });

  const json = extractFirstJsonObject(response.text);
  const parsed = parseReflectionJson(json);
  const instructions =
    parsed?.instructions?.trim() ||
    response.text.trim() ||
    "Return the exact numeric answer.";
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
        parsed?.summary?.trim() || "Reflection-generated instruction update.",
      instructions,
      rationale:
        rationale.length > 0
          ? rationale
          : [
              "The benchmark feedback indicates the instructions should return the exact numeric answer."
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
