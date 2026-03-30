import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
  Module,
  signature,
  type ModuleStore,
  type ModuleTrace
} from "@cloudflare/modules";
import { z } from "zod";
import { Evolve, TraceReviewStrategy, loadOptimizationContext } from "../index";

class EchoModule extends Module<
  z.ZodObject<{ query: z.ZodString }>,
  z.ZodObject<{ answer: z.ZodString }>
> {
  constructor() {
    super(
      signature("echo")
        .withInput(z.object({ query: z.string() }))
        .withOutput(z.object({ answer: z.string() }))
        .describeInputField("query", "The customer request to answer.")
        .describeOutputField(
          "answer",
          "The final answer returned to the caller."
        )
        .withInstructions("Answer the query directly.")
    );
  }

  protected override async forward(
    _context: never,
    input: { query: string }
  ): Promise<{ answer: string }> {
    return { answer: input.query };
  }
}

describe("evolve", () => {
  it("loads traces for a module path", async () => {
    const module = new EchoModule();
    const store = createStore();

    const context = await loadOptimizationContext({
      module,
      store,
      model: "test:model" as LanguageModel
    });

    expect(context.modulePath).toBe("echo");
    expect(context.traces).toHaveLength(1);
    expect(context.traces[0].events[0]?.message).toContain("missing");
  });

  it("returns default low-confidence suggestion when no traces exist", async () => {
    const module = new EchoModule();
    const store = createStore([], []);
    const strategy = new TraceReviewStrategy();

    const suggestion = await strategy.suggest({
      module,
      modulePath: "echo",
      traces: [],
      model: "test:model" as LanguageModel
    });

    expect(suggestion.confidence).toBe("low");
    expect(suggestion.summary).toContain("No traces available");
  });

  it("runs a trace review strategy and returns a suggestion", async () => {
    const module = new EchoModule();
    const store = createStore();
    const evolve = new Evolve({
      strategies: [
        new TraceReviewStrategy({
          async generateText() {
            return {
              output: {
                summary:
                  "The instructions should tell the model to ask for missing order ids.",
                suggestedInstructions:
                  "Answer the query directly. If order identifiers are missing, ask for them explicitly before answering.",
                suggestedInputFieldDescriptions: {
                  query:
                    "The raw customer request. If it lacks order identifiers, ask for them before proceeding."
                },
                suggestedOutputFieldDescriptions: {},
                rationale: [
                  "Recent traces show tool failures caused by missing identifiers."
                ],
                evidence: [
                  {
                    traceId: "trace-1",
                    modulePath: "echo",
                    issue: "tool_call_failed due to missing orderId"
                  }
                ],
                confidence: "medium"
              }
            } as Awaited<ReturnType<typeof import("ai").generateText>>;
          }
        })
      ]
    });

    const [suggestion] = await evolve.suggest({
      module,
      store,
      model: "test:model" as LanguageModel
    });

    expect(suggestion.strategy).toBe("trace-review");
    expect(suggestion.suggestedInstructions).toContain("missing");
    expect(suggestion.suggestedInputFieldDescriptions.query).toContain(
      "order identifiers"
    );
    expect(suggestion.evidence).toHaveLength(1);
  });

  it("retries with a smaller prompt when structured output generation fails", async () => {
    const module = new EchoModule();
    let calls = 0;
    const strategy = new TraceReviewStrategy({
      generateText: async ({ prompt }: { prompt: string }) => {
        calls += 1;

        if (calls === 1) {
          throw new Error("No object generated");
        }

        expect(prompt).toContain("Trace summary:");
        expect(prompt).not.toContain("Input schema JSON Schema:");

        return {
          output: {
            summary: "Ask for missing identifiers earlier.",
            suggestedInstructions:
              "Answer directly, but explicitly request any missing identifiers before proceeding.",
            suggestedInputFieldDescriptions: {},
            suggestedOutputFieldDescriptions: {},
            rationale: [
              "Recent traces show repeated missing identifier issues."
            ],
            evidence: [
              {
                traceId: "trace-1",
                modulePath: "echo",
                issue: "tool_call_failed due to missing orderId"
              }
            ],
            confidence: "medium"
          }
        } as Awaited<ReturnType<typeof import("ai").generateText>>;
      }
    });

    const suggestion = await strategy.suggest({
      module,
      modulePath: "echo",
      traces: [
        {
          trace: createStoreTrace(),
          events: createStoreEvents()
        }
      ],
      model: "test:model" as LanguageModel
    });

    expect(suggestion.summary).toContain("missing identifiers");
    expect(suggestion.confidence).toBe("medium");
    expect(calls).toBe(2);
  });

  it("applies suggested instructions and field descriptions as active artifacts", async () => {
    const module = new EchoModule();
    const artifacts: Array<{
      artifactId: string;
      modulePath: string;
      artifactType: string;
      version: string;
      contentJson: string;
      createdAt: number;
      isActive: boolean;
    }> = [];
    const store = createStore([], [], artifacts);
    const evolve = new Evolve({
      strategies: [
        new TraceReviewStrategy({
          async generateText() {
            return {
              output: {
                summary: "Tighten input handling.",
                suggestedInstructions:
                  "Answer the query directly. Ask for missing identifiers before answering.",
                suggestedInputFieldDescriptions: {
                  query:
                    "The incoming request. If identifiers are missing, ask for them before using tools."
                },
                suggestedOutputFieldDescriptions: {
                  answer:
                    "The final answer after all required identifiers have been collected."
                },
                rationale: [
                  "Repeated traces show missing identifier failures."
                ],
                evidence: [
                  {
                    traceId: "trace-1",
                    modulePath: "echo",
                    issue: "tool_call_failed due to missing orderId"
                  }
                ],
                confidence: "medium"
              }
            } as Awaited<ReturnType<typeof import("ai").generateText>>;
          }
        })
      ]
    });

    const [applied] = await evolve.apply({
      module,
      store,
      model: "test:model" as LanguageModel
    });

    expect(applied.appliedArtifacts.instructions).toBeTruthy();
    expect(applied.appliedArtifacts["input-field-descriptions"]).toBeTruthy();
    expect(applied.appliedArtifacts["output-field-descriptions"]).toBeTruthy();
    expect(
      artifacts.find((artifact) => artifact.artifactType === "instructions")
    ).toMatchObject({ isActive: true });
  });

  it("falls back to a heuristic suggestion when model review fails twice", async () => {
    const module = new EchoModule();
    const strategy = new TraceReviewStrategy({
      async generateText() {
        throw new Error("3030: Internal Server Error");
      }
    });

    const suggestion = await strategy.suggest({
      module,
      modulePath: "echo",
      traces: [
        {
          trace: createStoreTrace(),
          events: createStoreEvents()
        }
      ],
      model: "test:model" as LanguageModel
    });

    expect(suggestion.strategy).toBe("trace-review-fallback");
    expect(suggestion.confidence).toBe("low");
    expect(suggestion.summary).toContain("heuristically");
  });
});

function createStore(
  traces: ModuleTrace[] = [
    {
      traceId: "trace-1",
      modulePath: "echo",
      signatureName: "echo",
      moduleKind: "predict",
      status: "error",
      inputJson: '{"query":"refund me"}',
      outputJson: null,
      inputHash: "input-hash",
      outputHash: null,
      modelId: "test:model",
      adapterName: "ai-sdk-generate-text",
      instructionVersion: "default",
      inputFieldDescriptionsVersion: "default",
      outputFieldDescriptionsVersion: "default",
      contextVersion: "default",
      demoVersion: "default",
      usageJson: null,
      latencyMs: 12,
      errorJson: '{"message":"tool failed"}',
      createdAt: 2,
      finishedAt: 3
    }
  ],
  events = [
    {
      eventId: "event-1",
      traceId: "trace-1",
      seq: 1,
      visibility: "asi" as const,
      kind: "tool_call_failed",
      level: "warn" as const,
      message: "Tool call failed: searchOrders missing orderId",
      payloadJson: null,
      createdAt: 2
    }
  ],
  artifacts: Array<{
    artifactId: string;
    modulePath: string;
    artifactType: string;
    version: string;
    contentJson: string;
    createdAt: number;
    isActive: boolean;
  }> = []
): ModuleStore {
  return {
    async beginTrace() {},
    async finishTrace() {},
    async appendTraceEvent() {},
    async saveFeedback() {},
    async saveArtifact(artifact) {
      artifacts.push(artifact);
    },
    async getActiveArtifact(modulePath, artifactType) {
      return (
        artifacts.find(
          (artifact) =>
            artifact.modulePath === modulePath &&
            artifact.artifactType === artifactType &&
            artifact.isActive
        ) ?? null
      );
    },
    async activateArtifact(modulePath, artifactType, artifactId) {
      for (const artifact of artifacts) {
        if (
          artifact.modulePath === modulePath &&
          artifact.artifactType === artifactType
        ) {
          artifact.isActive = artifact.artifactId === artifactId;
        }
      }
    },
    async getTraces(modulePath) {
      return traces.filter((trace) => trace.modulePath === modulePath);
    },
    async getTraceEvents(traceId) {
      return events.filter((event) => event.traceId === traceId);
    }
  };
}

function createStoreTrace(): ModuleTrace {
  return {
    traceId: "trace-1",
    modulePath: "echo",
    signatureName: "echo",
    moduleKind: "predict",
    status: "error",
    inputJson: '{"query":"refund me"}',
    outputJson: null,
    inputHash: "input-hash",
    outputHash: null,
    modelId: "test:model",
    adapterName: "ai-sdk-generate-text",
    instructionVersion: "default",
    inputFieldDescriptionsVersion: "default",
    outputFieldDescriptionsVersion: "default",
    contextVersion: "default",
    demoVersion: "default",
    usageJson: null,
    latencyMs: 12,
    errorJson: '{"message":"tool failed"}',
    createdAt: 2,
    finishedAt: 3
  };
}

function createStoreEvents() {
  return [
    {
      eventId: "event-1",
      traceId: "trace-1",
      seq: 1,
      visibility: "asi" as const,
      kind: "tool_call_failed",
      level: "warn" as const,
      message: "Tool call failed: searchOrders missing orderId",
      payloadJson: null,
      createdAt: 2
    }
  ];
}
