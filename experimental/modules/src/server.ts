import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { Think } from "@cloudflare/think";
import {
  Module,
  Predict,
  SqliteModuleStore,
  image,
  signature,
  type ModuleContext
} from "@cloudflare/modules";
import type { LanguageModel } from "ai";
import { z } from "zod";

const MODEL_ID = "@cf/meta/llama-4-scout-17b-16e-instruct";

const classifyTicketSignature = signature("supportWorkflow.classify")
  .withInput(
    z.object({
      customer: z.string(),
      query: z.string()
    })
  )
  .withOutput(
    z.object({
      team: z.enum(["billing", "technical", "operations"]),
      urgency: z.enum(["low", "medium", "high"]),
      sentiment: z.enum(["calm", "frustrated", "urgent"]),
      reasoning: z.string()
    })
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
  .withOutput(
    z.object({
      summary: z.string(),
      nextAction: z.string(),
      customerReply: z.string()
    })
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
  .withOutput(
    z.object({
      classification: classifyTicketSignature.output,
      resolution: draftReplySignature.output
    })
  )
  .withInstructions(
    "Run support classification first, then draft the handoff summary and reply."
  );

const describeScreenshotSignature = signature("describeScreenshot")
  .withInput(
    z.object({
      question: z.string(),
      screenshot: image()
    })
  )
  .withOutput(
    z.object({
      answer: z.string(),
      notableDetails: z.array(z.string()).min(2).max(4),
      suggestedAltText: z.string()
    })
  ).withInstructions(`Answer the user's question about the screenshot.

Mention notable visual details that support the answer and suggest a concise alt text.`);

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
export type DescribeScreenshotRequest = z.infer<
  typeof describeScreenshotSignature.input
>;
export type DescribeScreenshotResult = z.infer<
  typeof describeScreenshotSignature.output
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

export class ModulesExampleAgent extends Think<Env> {
  supportWorkflow = new SupportWorkflowModule();
  describeScreenshotModule = new Predict(describeScreenshotSignature);

  override getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID, {
      sessionAffinity: this.sessionAffinity
    });
  }

  override getSystemPrompt(): string {
    return "You are a typed module host.";
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
      traces: await this.getTraceSummaries([
        "supportWorkflow",
        "supportWorkflow.classify",
        "supportWorkflow.reply"
      ])
    };
  }

  @callable()
  async describeScreenshot(
    input: DescribeScreenshotRequest
  ): Promise<ModuleRunResponse<DescribeScreenshotResult>> {
    const result = await this.describeScreenshotModule.invoke(
      this.getModuleContext(),
      input
    );

    return {
      result,
      traces: await this.getTraceSummaries(["describeScreenshot"])
    };
  }

  @callable()
  async getExampleTraceSnapshot(): Promise<{
    supportWorkflow: TraceSummary[];
    describeScreenshot: TraceSummary[];
  }> {
    return {
      supportWorkflow: await this.getTraceSummaries([
        "supportWorkflow",
        "supportWorkflow.classify",
        "supportWorkflow.reply"
      ]),
      describeScreenshot: await this.getTraceSummaries(["describeScreenshot"])
    };
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
      .sort((a, b) => b.createdAt - a.createdAt)
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

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
