import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import {
  Module,
  Predict,
  SqliteModuleStore,
  signature,
  type ModuleContext
} from "@cloudflare/modules";
import {
  Evolve,
  type AppliedImprovement,
  type SignatureImprovementSuggestion
} from "@cloudflare/evolve";
import type { LanguageModel } from "ai";
import { z } from "zod";

const WORKFLOW_MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";
const EVOLVE_MODEL_ID = "@cf/moonshotai/kimi-k2.5";

const classifyTicketSignature = signature("supportWorkflow.classify")
  .withInput(
    z.object({
      customer: z.string(),
      query: z.string()
    })
  )
  .describeInputField(
    "customer",
    "The account or customer name requesting help."
  )
  .describeInputField("query", "The full support request to classify.")
  .withOutput(
    z.object({
      team: z.enum(["billing", "technical", "operations"]),
      urgency: z.enum(["low", "medium", "high"]),
      sentiment: z.enum(["calm", "frustrated", "urgent"]),
      reasoning: z.string()
    })
  )
  .describeOutputField("team", "The team best suited to handle the request.")
  .describeOutputField("urgency", "How quickly the request should be handled.")
  .describeOutputField(
    "sentiment",
    "The customer sentiment inferred from the request."
  )
  .describeOutputField(
    "reasoning",
    "A short explanation for the classification."
  ).withInstructions(`Classify the incoming support request.

Return the best team, urgency, sentiment, and a short reasoning string.`);

const draftReplySignature = signature("supportWorkflow.reply")
  .withInput(
    z.object({
      customer: z.string(),
      query: z.string(),
      team: z.enum(["billing", "technical", "operations"]),
      urgency: z.enum(["low", "medium", "high"]),
      sentiment: z.enum(["calm", "frustrated", "urgent"])
    })
  )
  .describeInputField("customer", "The customer receiving the reply.")
  .describeInputField("query", "The original support request.")
  .describeInputField("team", "The team taking ownership of the request.")
  .describeInputField("urgency", "The urgency level from classification.")
  .describeInputField(
    "sentiment",
    "The customer sentiment from classification."
  )
  .withOutput(
    z.object({
      summary: z.string(),
      nextAction: z.string(),
      customerReply: z.string()
    })
  )
  .describeOutputField(
    "summary",
    "The internal handoff summary for the support team."
  )
  .describeOutputField(
    "nextAction",
    "The next concrete action support should take."
  )
  .describeOutputField(
    "customerReply",
    "The short response sent back to the customer."
  )
  .withInstructions(`Draft an internal support handoff summary and a short reply.

Keep the customer reply crisp, specific, and professional.`);

const supportWorkflowSignature = signature("supportWorkflow")
  .withInput(
    z.object({
      customer: z.string(),
      query: z.string()
    })
  )
  .describeInputField("customer", "The customer or account name.")
  .describeInputField("query", "The raw support request to route and answer.")
  .withOutput(
    z.object({
      classification: classifyTicketSignature.output,
      resolution: draftReplySignature.output
    })
  )
  .describeOutputField(
    "classification",
    "The structured routing decision for the request."
  )
  .describeOutputField(
    "resolution",
    "The structured internal and external response package."
  )
  .withInstructions(
    "Run support classification first, then draft the handoff summary and reply."
  );

class SupportWorkflowModule extends Module<
  typeof supportWorkflowSignature.input,
  typeof supportWorkflowSignature.output
> {
  classify = this.child("classify", new Predict(classifyTicketSignature));
  reply = this.child("reply", new Predict(draftReplySignature));

  constructor() {
    super(supportWorkflowSignature);
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
    input: z.output<typeof supportWorkflowSignature.input>
  ): Promise<z.output<typeof supportWorkflowSignature.output>> {
    const classification = await this.classify.invoke(context, input);

    context.asi?.log("Completed support classification.", {
      team: classification.team,
      urgency: classification.urgency
    });

    const resolution = await this.reply.invoke(context, {
      customer: input.customer,
      query: input.query,
      team: classification.team,
      urgency: classification.urgency,
      sentiment: classification.sentiment
    });

    return {
      classification,
      resolution
    };
  }
}

export type SupportWorkflowRequest = z.infer<
  typeof supportWorkflowSignature.input
>;
export type SupportWorkflowResult = z.infer<
  typeof supportWorkflowSignature.output
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

export type EvolveResponse = {
  suggestions: SignatureImprovementSuggestion[];
  applied: AppliedImprovement[];
  traces: TraceSummary[];
  currentConfig: Record<
    "workflow" | "classify" | "reply",
    {
      instructions: string | undefined;
      inputFieldDescriptions: Record<string, string>;
      outputFieldDescriptions: Record<string, string>;
    }
  >;
};

export class EvolveExampleAgent extends Think<Env> {
  supportWorkflow = new SupportWorkflowModule();
  evolve = new Evolve();

  override getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(WORKFLOW_MODEL_ID, {
      sessionAffinity: this.sessionAffinity
    });
  }

  private getEvolveModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(EVOLVE_MODEL_ID, {
      sessionAffinity: this.sessionAffinity
    });
  }

  override getSystemPrompt(): string {
    return "You are an experimental evolve host.";
  }

  private getModuleStore() {
    return new SqliteModuleStore((strings, ...values) =>
      this.sql(strings, ...values)
    );
  }

  private getModuleContext(): ModuleContext {
    return {
      model: this.getModel(),
      store: this.getModuleStore(),
      host: this
    };
  }

  @callable()
  async triageSupport(
    input: SupportWorkflowRequest
  ): Promise<ModuleRunResponse<SupportWorkflowResult>> {
    const result = await this.supportWorkflow.invoke(
      this.getModuleContext(),
      input
    );

    return {
      result,
      traces: await this.getTraceSummaries()
    };
  }

  @callable()
  async suggestSupportImprovements(): Promise<EvolveResponse> {
    const suggestions = await this.evolve.suggest({
      module: this.supportWorkflow,
      store: this.getModuleStore(),
      model: this.getEvolveModel(),
      includeChildren: true,
      limitPerModule: 5
    });

    return {
      suggestions,
      applied: [],
      traces: await this.getTraceSummaries(),
      currentConfig: await this.getCurrentConfig()
    };
  }

  @callable()
  async applySupportImprovements(): Promise<EvolveResponse> {
    const applied = await this.evolve.apply({
      module: this.supportWorkflow,
      store: this.getModuleStore(),
      model: this.getEvolveModel(),
      includeChildren: true,
      limitPerModule: 5
    });

    return {
      suggestions: applied.map((entry) => entry.suggestion),
      applied,
      traces: await this.getTraceSummaries(),
      currentConfig: await this.getCurrentConfig()
    };
  }

  private async getCurrentConfig(): Promise<EvolveResponse["currentConfig"]> {
    return {
      workflow: await this.getCurrentModuleConfig(this.supportWorkflow),
      classify: await this.getCurrentModuleConfig(
        this.supportWorkflow.classify
      ),
      reply: await this.getCurrentModuleConfig(this.supportWorkflow.reply)
    };
  }

  private async getCurrentModuleConfig(
    module: Module<z.ZodTypeAny, z.ZodTypeAny>
  ) {
    const store = this.getModuleStore();
    const modulePath = module.getPath();
    const [
      instructionsArtifact,
      inputDescriptionsArtifact,
      outputDescriptionsArtifact
    ] = await Promise.all([
      store.getActiveArtifact(modulePath, "instructions"),
      store.getActiveArtifact(modulePath, "input-field-descriptions"),
      store.getActiveArtifact(modulePath, "output-field-descriptions")
    ]);

    return {
      instructions:
        parseArtifactValue<string>(instructionsArtifact?.contentJson) ??
        module.signature.instructions,
      inputFieldDescriptions: {
        ...module.signature.inputFieldDescriptions,
        ...parseArtifactValue<Record<string, string>>(
          inputDescriptionsArtifact?.contentJson
        )
      },
      outputFieldDescriptions: {
        ...module.signature.outputFieldDescriptions,
        ...parseArtifactValue<Record<string, string>>(
          outputDescriptionsArtifact?.contentJson
        )
      }
    };
  }

  private async getTraceSummaries(): Promise<TraceSummary[]> {
    const store = this.getModuleStore();
    const modulePaths = [
      "supportWorkflow",
      "supportWorkflow.classify",
      "supportWorkflow.reply"
    ];
    const traces = (
      await Promise.all(
        modulePaths.map((modulePath) =>
          store.getTraces(modulePath, {
            limit: 5
          })
        )
      )
    )
      .flat()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

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

function parseArtifactValue<T>(value: string | undefined): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
