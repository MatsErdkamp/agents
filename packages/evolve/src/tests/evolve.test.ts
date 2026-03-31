import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
  Module,
  type ModuleArtifact,
  signature,
  type ModuleFeedback,
  type ModuleStore,
  type ModuleTrace,
  type ModuleTraceEvent
} from "@cloudflare/modules";
import { z } from "zod";
import {
  Evolve,
  ModuleTraceAdapter,
  TraceReviewStrategy,
  loadOptimizationContext
} from "../index";

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

class InstructionAwareModule extends Module<
  z.ZodObject<{ problem: z.ZodString }>,
  z.ZodObject<{ answer: z.ZodString }>
> {
  constructor() {
    super(
      signature("solve")
        .withInput(z.object({ problem: z.string() }))
        .withOutput(z.object({ answer: z.string() }))
        .withInstructions('Solve the problem, but always output "0".')
    );
  }

  protected override async forward(
    context: {
      resolved: {
        instructions?: string;
      };
    },
    input: { problem: string }
  ): Promise<{ answer: string }> {
    const improved =
      context.resolved.instructions?.includes(
        "Return the exact numeric answer"
      ) ?? false;

    if (!improved) {
      return { answer: "0" };
    }

    switch (input.problem) {
      case "What is 2 + 2?":
        return { answer: "4" };
      case "What is 3 * 3?":
        return { answer: "9" };
      default:
        return { answer: "0" };
    }
  }
}

class FieldDescriptionAwareModule extends Module<
  z.ZodObject<{ problem: z.ZodString }>,
  z.ZodObject<{ answer: z.ZodString }>
> {
  constructor() {
    super(
      signature("describe")
        .withInput(z.object({ problem: z.string() }))
        .withOutput(z.object({ answer: z.string() }))
    );
  }

  protected override async forward(
    context: {
      resolved: {
        outputFieldDescriptions: Record<string, string>;
      };
    },
    input: { problem: string }
  ): Promise<{ answer: string }> {
    const improved =
      context.resolved.outputFieldDescriptions.answer?.includes(
        "exact numeric answer"
      ) ?? false;

    if (!improved) {
      return { answer: "0" };
    }

    switch (input.problem) {
      case "What is 5 + 5?":
        return { answer: "10" };
      case "What is 8 - 3?":
        return { answer: "5" };
      default:
        return { answer: "0" };
    }
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
    const store = createStore([], [], [], artifacts);
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

  it("builds reflective examples from traces, ASI, and feedback", async () => {
    const store = createStore([createStoreTrace()], createStoreEvents(), [
      {
        id: "feedback-1",
        traceId: "trace-1",
        score: 0,
        label: "incorrect",
        comment: JSON.stringify({ expectedAnswer: "4" }),
        createdAt: 4
      }
    ]);
    const adapter = new ModuleTraceAdapter();
    const module = new EchoModule();

    const [example] = await adapter.loadExamples({
      module,
      store,
      modulePath: "echo"
    });

    expect(example.traceId).toBe("trace-1");
    expect(example.asi[0]?.message).toContain("missing orderId");
    expect(example.feedback[0]?.label).toBe("incorrect");
    expect(adapter.renderExample(example)).toContain("Feedback");
  });

  it("runs the GEPA optimize loop and activates the winning instructions", async () => {
    const module = new InstructionAwareModule();
    const traces: ModuleTrace[] = [];
    const events: ModuleTraceEvent[] = [];
    const feedback: ModuleFeedback[] = [];
    const artifacts: ModuleArtifact[] = [];
    const store = createStore(traces, events, feedback, artifacts);

    const benchmark = [
      { problem: "What is 2 + 2?", expected: "4" },
      { problem: "What is 3 * 3?", expected: "9" }
    ];

    for (const [index, example] of benchmark.entries()) {
      const run = await module.invokeWithTrace(
        {
          model: "test:model" as LanguageModel,
          store
        },
        { problem: example.problem }
      );
      await store.appendTraceEvent({
        eventId: `asi-${index}`,
        traceId: run.traceId,
        seq: index + 1,
        visibility: "asi",
        kind: "wrong_answer",
        level: "warn",
        message: `Expected ${example.expected} but got ${run.output.answer}`,
        payloadJson: JSON.stringify({ expectedAnswer: example.expected }),
        createdAt: Date.now()
      });
      await store.saveFeedback({
        id: `feedback-${index}`,
        traceId: run.traceId,
        score: run.output.answer === example.expected ? 1 : 0,
        label: run.output.answer === example.expected ? "correct" : "incorrect",
        comment: JSON.stringify({ expectedAnswer: example.expected }),
        createdAt: Date.now()
      });
    }

    const evolve = new Evolve({
      generateText: async () =>
        ({
          output: {
            summary: "Remove the forced zero behavior and answer exactly.",
            instructions:
              "Solve the math problem carefully. Return the exact numeric answer in the answer field.",
            rationale: [
              "The replay data shows the current instructions force the wrong constant answer."
            ]
          }
        }) as Awaited<ReturnType<typeof import("ai").generateText>>
    });
    const adapter = new ModuleTraceAdapter({
      score: ({ example, output }) => {
        const expected = JSON.parse(example.feedback[0]?.comment ?? "{}") as {
          expectedAnswer?: string;
        };
        return output != null &&
          typeof output === "object" &&
          "answer" in output &&
          (output as { answer: string }).answer === expected.expectedAnswer
          ? 1
          : 0;
      }
    });

    const result = await evolve.optimize({
      module,
      store,
      reflectionModel: "test:reflection" as LanguageModel,
      executionContext: {
        model: "test:execution" as LanguageModel
      },
      adapter,
      activate: true,
      maxIterations: 1,
      minibatchSize: 2,
      validationSplit: 0.5
    });

    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.seedCandidate.validationScore).toBe(0);
    expect(result.bestCandidate.validationScore).toBe(1);
    expect(result.bestCandidate.instructions).toContain("exact numeric answer");
    expect(result.appliedArtifacts.instructions).toBeTruthy();
    expect(
      await store.getActiveArtifact("solve", "instructions")
    ).toMatchObject({
      isActive: true
    });
  });

  it("optimizes output field descriptions as text parameters", async () => {
    const module = new FieldDescriptionAwareModule();
    const traces: ModuleTrace[] = [];
    const events: ModuleTraceEvent[] = [];
    const feedback: ModuleFeedback[] = [];
    const artifacts: ModuleArtifact[] = [];
    const store = createStore(traces, events, feedback, artifacts);

    const benchmark = [
      { problem: "What is 5 + 5?", expected: "10" },
      { problem: "What is 8 - 3?", expected: "5" }
    ];

    for (const [index, example] of benchmark.entries()) {
      const run = await module.invokeWithTrace(
        {
          model: "test:model" as LanguageModel,
          store
        },
        { problem: example.problem }
      );
      await store.appendTraceEvent({
        eventId: `field-asi-${index}`,
        traceId: run.traceId,
        seq: index + 1,
        visibility: "asi",
        kind: "ambiguous_output_field",
        level: "warn",
        message: `The answer field should contain the exact numeric answer ${example.expected}.`,
        payloadJson: JSON.stringify({ expectedAnswer: example.expected }),
        createdAt: Date.now()
      });
      await store.saveFeedback({
        id: `field-feedback-${index}`,
        traceId: run.traceId,
        score: run.output.answer === example.expected ? 1 : 0,
        label: run.output.answer === example.expected ? "correct" : "incorrect",
        comment: JSON.stringify({ expectedAnswer: example.expected }),
        createdAt: Date.now()
      });
    }

    const evolve = new Evolve({
      generateText: async () =>
        ({
          output: {
            summary: "Clarify the output field contract.",
            instructions: "The exact numeric answer as a string.",
            rationale: [
              "The examples show the answer field description is too weak to guide the module."
            ]
          }
        }) as Awaited<ReturnType<typeof import("ai").generateText>>
    });
    const adapter = new ModuleTraceAdapter({
      score: ({ example, output }) => {
        const expected = JSON.parse(example.feedback[0]?.comment ?? "{}") as {
          expectedAnswer?: string;
        };
        return output != null &&
          typeof output === "object" &&
          "answer" in output &&
          (output as { answer: string }).answer === expected.expectedAnswer
          ? 1
          : 0;
      }
    });

    const result = await evolve.optimize({
      module,
      store,
      reflectionModel: "test:reflection" as LanguageModel,
      executionContext: {
        model: "test:execution" as LanguageModel
      },
      adapter,
      activate: true,
      maxIterations: 1,
      minibatchSize: 2,
      validationSplit: 0.5,
      componentSelector: {
        nextComponent({ components }) {
          const component = components.find(
            (entry) => entry.id === "output-field-description:describe:answer"
          );
          if (!component) {
            throw new Error("Missing output field description component.");
          }
          return component;
        }
      }
    });

    expect(result.bestCandidate.validationScore).toBe(1);
    expect(result.bestCandidate.component).toBe(
      "output-field-description:describe:answer"
    );
    expect(
      result.bestCandidate.parameters[
        "output-field-description:describe:answer"
      ]
    ).toContain("exact numeric answer");
    expect(result.appliedArtifacts["output-field-descriptions"]).toBeTruthy();
    expect(
      await store.getActiveArtifact("describe", "output-field-descriptions")
    ).toMatchObject({ isActive: true });
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
  feedback: ModuleFeedback[] = [],
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
    async beginTrace(trace) {
      traces.push(trace);
    },
    async finishTrace(traceId, update) {
      const index = traces.findIndex((trace) => trace.traceId === traceId);
      if (index >= 0) {
        traces[index] = { ...traces[index], ...update };
      }
    },
    async appendTraceEvent(event) {
      events.push(event);
    },
    async saveFeedback(entry) {
      feedback.push(entry);
    },
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
    },
    async getFeedback(options) {
      if (options.traceId) {
        return feedback.filter((entry) => entry.traceId === options.traceId);
      }

      if (options.traceIds?.length) {
        return feedback.filter((entry) =>
          options.traceIds?.includes(entry.traceId)
        );
      }

      if (options.modulePath) {
        const traceIds = new Set(
          traces
            .filter((trace) => trace.modulePath === options.modulePath)
            .map((trace) => trace.traceId)
        );
        return feedback.filter((entry) => traceIds.has(entry.traceId));
      }

      return feedback;
    },
    async getTraceBundle(traceId) {
      const trace = traces.find((entry) => entry.traceId === traceId);
      if (!trace) {
        return null;
      }

      return {
        trace,
        events: events.filter((event) => event.traceId === traceId),
        feedback: feedback.filter((entry) => entry.traceId === traceId)
      };
    },
    async listModulePaths() {
      return [...new Set(traces.map((trace) => trace.modulePath))];
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
