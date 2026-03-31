import { generateText, type LanguageModel } from "ai";
import { Agent, callable, routeAgentRequest } from "agents";
import {
  SqliteEvolveStore,
  createAgentEvolveHelpers
} from "../../../packages/evolve/src/index";
import {
  RLM,
  SqliteModuleStore,
  signature,
  type ModuleContext
} from "@cloudflare/modules";
import {
  createSubAgentQueryProvider,
  type RLMSubAgentQueryRequest
} from "@cloudflare/modules/agents";
import { createShellRLMRuntime } from "@cloudflare/modules/workers";
import { Workspace } from "@cloudflare/shell";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";
const INVESTIGATE_PATH = "rlmWorkflow.investigateDossier";

const investigateDossierSignature = signature(INVESTIGATE_PATH)
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
  .withInstructions(`Answer the question using only evidence you inspected from the shell-backed dossier.

Requirements:
- Inspect the dossier with state.* before making claims.
- Very large dossiers may be stored as "*.r2.txt" pointers: inspect the pointer file, then use the R2 helpers to read the actual text.
- Do not stop after finding an R2 pointer; inspect the relevant text needed to answer the question.
- For questions about positions or fractions of a large text, inspect the text around those positions before answering.
- Keep a short working memory in scratch.
- Return 2-5 evidence items with exact file paths and short quoted snippets.
- Confidence should drop when the dossier is ambiguous.
- Approach should briefly describe how you verified the answer.`);

const QUERY_SYSTEM_PROMPT = `You are a narrow semantic helper for an RLM parent.

Answer only the scoped request you are given.
Do not assume missing context.
Be concise and concrete.`;

export type InvestigationRequest = z.infer<
  typeof investigateDossierSignature.input
>;
export type InvestigationResult = z.infer<
  typeof investigateDossierSignature.output
>;

export type TraceSummary = {
  traceId: string;
  modulePath: string;
  status: "running" | "success" | "error" | "validation_error";
  latencyMs: number | null;
  modelId: string | null;
  createdAt: number;
  asiEvents: number;
  metaEvents: number;
  latestAsiMessage: string | null;
};

export type ModuleRunResponse<T> = {
  result: T;
  traces: TraceSummary[];
};

class QueryAgent extends Agent<Env> {
  async query(input: RLMSubAgentQueryRequest): Promise<string> {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = await generateText({
      model: workersai(MODEL_ID, {
        sessionAffinity: this.sessionAffinity
      }),
      maxOutputTokens: 2048,
      system: QUERY_SYSTEM_PROMPT,
      prompt: formatQueryPrompt(input)
    });

    return result.text;
  }
}

export class RlmLabAgent extends Agent<Env> {
  private getArtifactBucket(): R2Bucket {
    return (this.env as Env & { RLM_ARTIFACTS: R2Bucket }).RLM_ARTIFACTS;
  }

  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "rlm_lab",
    name: () => this.name
  });

  investigatorModule = new RLM(investigateDossierSignature, {
    runtime: createShellRLMRuntime({
      workspace: this.workspace,
      loader: this.env.LOADER,
      artifactBucket: this.getArtifactBucket(),
      artifactPrefix: "rlm-lab"
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

  private getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID, {
      sessionAffinity: this.sessionAffinity
    });
  }

  private getModuleStore() {
    return new SqliteModuleStore((strings, ...values) =>
      this.sql(strings, ...values)
    );
  }

  private getEvolveStore() {
    return new SqliteEvolveStore(
      (
        strings: TemplateStringsArray,
        ...values: Array<string | number | boolean | null>
      ) => this.sql(strings, ...values)
    );
  }

  private getEvolveHelpers() {
    return createAgentEvolveHelpers({
      store: this.getModuleStore(),
      evolveStore: this.getEvolveStore(),
      emit: (type: string, payload?: Record<string, unknown>) => {
        this.broadcast(
          JSON.stringify({
            type: "module-event",
            eventType: type,
            payload: payload ?? null
          })
        );
      }
    });
  }

  private getModuleContext(): ModuleContext {
    return this.getEvolveHelpers().createModuleContext({
      model: this.getModel(),
      host: this,
      maxOutputTokens: 4096
    });
  }

  @callable()
  async runInvestigation(
    input: InvestigationRequest
  ): Promise<ModuleRunResponse<InvestigationResult>> {
    const result = await this.investigatorModule.invoke(
      this.getModuleContext(),
      input
    );

    return {
      result,
      traces: await this.getTraceSummaries([
        INVESTIGATE_PATH,
        `${INVESTIGATE_PATH}.act`,
        `${INVESTIGATE_PATH}.extract`
      ])
    };
  }

  @callable()
  async getTraceSnapshot(): Promise<{
    investigation: TraceSummary[];
  }> {
    return {
      investigation: await this.getTraceSummaries([
        INVESTIGATE_PATH,
        `${INVESTIGATE_PATH}.act`,
        `${INVESTIGATE_PATH}.extract`
      ])
    };
  }

  @callable()
  async saveTraceFeedback(input: {
    traceId: string;
    score?: number | null;
    label?: string | null;
    comment?: string | null;
  }) {
    return this.getEvolveHelpers().saveTraceFeedback(input);
  }

  @callable()
  async getOptimizationRuns() {
    return this.getEvolveHelpers().listRuns(INVESTIGATE_PATH, 10);
  }

  private async getTraceSummaries(
    modulePaths: string[]
  ): Promise<TraceSummary[]> {
    const store = this.getModuleStore();
    const traces = (
      await Promise.all(
        modulePaths.map((modulePath) =>
          store.getTraces(modulePath, {
            limit: 4
          })
        )
      )
    )
      .flat()
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 8);

    return traces.map((trace) => ({
      traceId: trace.traceId,
      modulePath: trace.modulePath,
      status: trace.status,
      latencyMs: trace.latencyMs,
      modelId: trace.modelId,
      createdAt: trace.createdAt,
      asiEvents: this.countTraceEvents(trace.traceId, "asi"),
      metaEvents: this.countTraceEvents(trace.traceId, "meta"),
      latestAsiMessage: this.getLatestTraceMessage(trace.traceId, "asi")
    }));
  }

  private countTraceEvents(
    traceId: string,
    visibility: "asi" | "meta"
  ): number {
    const rows = this.sql<{ count: number }>`
      SELECT COUNT(*) as count
      FROM module_trace_events
      WHERE trace_id = ${traceId} AND visibility = ${visibility}
    `;

    return Number(rows[0]?.count ?? 0);
  }

  private getLatestTraceMessage(
    traceId: string,
    visibility: "asi" | "meta"
  ): string | null {
    const rows = this.sql<{ message: string }>`
      SELECT message
      FROM module_trace_events
      WHERE trace_id = ${traceId} AND visibility = ${visibility}
      ORDER BY seq DESC
      LIMIT 1
    `;

    return rows[0]?.message ?? null;
  }
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

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
