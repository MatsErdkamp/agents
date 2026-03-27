import { generateText, tool, type LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AISDKGenerateObjectAdapter,
  AISDKGenerateTextAdapter,
  Predict,
  SqliteModuleStore,
  image,
  signature
} from "../modules";
import type {
  ModuleContext,
  ModuleStore,
  ModuleTrace,
  ModuleTraceEvent
} from "../modules";

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

describe("predict signature builder", () => {
  it("preserves zod input and output types", () => {
    const sig = signature("classifyQuery")
      .withInput(z.object({ query: z.string() }))
      .withOutput(z.object({ category: z.string() }))
      .withInstructions("Classify the query.");

    expect(sig.name).toBe("classifyQuery");
    expect(sig.instructions).toBe("Classify the query.");
    expect(sig.input.parse({ query: "hello" })).toEqual({ query: "hello" });
    expect(sig.output.parse({ category: "general" })).toEqual({
      category: "general"
    });
  });
});

describe("ai sdk adapter rendering", () => {
  it("renders multimodal image input as ai sdk messages", () => {
    const sig = signature("describeImage")
      .withInput(
        z.object({
          question: z.string(),
          screenshot: image()
        })
      )
      .withOutput(z.object({ answer: z.string() }))
      .withInstructions("Describe the image.");

    const adapter = new AISDKGenerateTextAdapter();
    const rendered = adapter.renderInput(sig, {
      question: "What is in this image?",
      screenshot: {
        type: "image",
        url: "https://example.com/cat.png"
      }
    });

    expect(rendered.system).toBe("Describe the image.");
    expect(rendered.messages).toHaveLength(1);

    const [message] = rendered.messages;
    expect(message.role).toBe("user");
    expect(Array.isArray(message.content)).toBe(true);

    if (!Array.isArray(message.content)) {
      throw new Error("Expected array content");
    }

    expect(message.content[0]).toEqual({
      type: "text",
      text: "signature: describeImage"
    });
    expect(message.content[1]).toEqual({
      type: "text",
      text: "question:\nWhat is in this image?"
    });
    expect(message.content[2]).toEqual({
      type: "text",
      text: "screenshot:"
    });
    expect(message.content[3]).toMatchObject({
      type: "image"
    });
  });
});

describe("predict invocation and tracing", () => {
  it("uses the default adapter alias and writes traces", async () => {
    const traces: ModuleTrace[] = [];
    const events: ModuleTraceEvent[] = [];
    const store = createStore(traces, events);

    const sig = signature("classifyQuery")
      .withInput(z.object({ query: z.string() }))
      .withOutput(z.object({ category: z.string() }));

    const predict = new Predict(sig, {
      adapter: new AISDKGenerateObjectAdapter({
        async generateText() {
          return createGenerateTextResult({ category: "refund" });
        }
      })
    });

    const context = {
      model: "test:model" as LanguageModel,
      store
    } satisfies ModuleContext;

    const result = await predict.invoke(context, { query: "refund me" });

    expect(result).toEqual({ category: "refund" });
    expect(traces).toHaveLength(1);
    expect(traces[0].moduleKind).toBe("predict");
    expect(traces[0].status).toBe("success");
    expect(traces[0].adapterName).toBe("ai-sdk-generate-text");
    expect(traces[0].outputJson).toContain("refund");
    expect(events).toHaveLength(0);
  });

  it("traces tool lifecycle callbacks when tools are provided", async () => {
    const traces: ModuleTrace[] = [];
    const events: ModuleTraceEvent[] = [];
    const store = createStore(traces, events);

    const sig = signature("classifyQuery")
      .withInput(z.object({ query: z.string() }))
      .withOutput(z.object({ category: z.string() }));

    const searchOrders = tool({
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => ({ ok: true })
    });

    const predict = new Predict(sig, {
      adapter: new AISDKGenerateTextAdapter({
        async generateText(options) {
          await options.experimental_onToolCallStart?.({
            stepNumber: 0,
            model: undefined,
            toolCall: {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "searchOrders",
              input: { orderId: "123" }
            },
            messages: options.messages ?? [],
            abortSignal: undefined,
            functionId: undefined,
            metadata: undefined,
            experimental_context: undefined
          });

          await options.experimental_onToolCallFinish?.({
            stepNumber: 0,
            model: undefined,
            toolCall: {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "searchOrders",
              input: { orderId: "123" }
            },
            abortSignal: undefined,
            functionId: undefined,
            metadata: undefined,
            experimental_context: undefined,
            success: false,
            error: new Error("missing required field orderId")
          });

          return createGenerateTextResult({ category: "refund" });
        }
      })
    });

    await predict.invoke(
      {
        model: "test:model" as LanguageModel,
        tools: { searchOrders },
        store
      },
      { query: "refund me" }
    );

    expect(events.some((event) => event.kind === "tool_call_started")).toBe(
      true
    );
    expect(events.some((event) => event.kind === "tool_call_failed")).toBe(
      true
    );
    expect(events.some((event) => event.visibility === "asi")).toBe(true);
  });

  it("records actionable validation failures as ASI", async () => {
    const traces: ModuleTrace[] = [];
    const events: ModuleTraceEvent[] = [];
    const store = createStore(traces, events);

    const sig = signature("broken")
      .withInput(z.object({ query: z.string() }))
      .withOutput(z.object({ category: z.string() }));

    const predict = new Predict(sig, {
      adapter: new AISDKGenerateTextAdapter({
        async generateText() {
          return createGenerateTextResult({ wrong: true });
        }
      })
    });

    await expect(
      predict.invoke(
        {
          model: "test:model" as LanguageModel,
          store
        },
        { query: "refund me" }
      )
    ).rejects.toThrow();

    expect(traces[0].status).toBe("validation_error");
    expect(events.some((event) => event.visibility === "asi")).toBe(true);
    expect(
      events.some((event) => event.kind === "output_validation_failed")
    ).toBe(true);
  });
});

describe("sqlite module store", () => {
  it("is constructible with tagged sql implementations", async () => {
    const statements: string[] = [];
    const sql = (
      strings: TemplateStringsArray,
      ...values: Array<string | number | boolean | null>
    ) => {
      statements.push(
        strings.reduce((result, chunk, index) => {
          const value = values[index];
          return `${result}${chunk}${value === undefined ? "" : "?"}`;
        }, "")
      );
      return [];
    };

    const store = new SqliteModuleStore(sql);
    await store.beginTrace({
      traceId: "trace-1",
      modulePath: "root.predict",
      signatureName: "predict",
      moduleKind: "predict",
      status: "running",
      inputJson: "{}",
      outputJson: null,
      inputHash: "hash",
      outputHash: null,
      modelId: null,
      adapterName: null,
      instructionVersion: "default",
      contextVersion: "default",
      demoVersion: "default",
      usageJson: null,
      latencyMs: null,
      errorJson: null,
      createdAt: 1,
      finishedAt: null
    });

    expect(
      statements.some((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS module_traces")
      )
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes("INSERT INTO module_traces")
      )
    ).toBe(true);
  });
});

function createStore(
  traces: ModuleTrace[],
  events: ModuleTraceEvent[]
): ModuleStore {
  return {
    async beginTrace(trace) {
      traces.push(trace);
    },
    async finishTrace(traceId, update) {
      const index = traces.findIndex((trace) => trace.traceId === traceId);
      traces[index] = { ...traces[index], ...update };
    },
    async appendTraceEvent(event) {
      events.push(event);
    },
    async saveFeedback() {},
    async getTraces(modulePath) {
      return traces.filter((trace) => trace.modulePath === modulePath);
    }
  };
}

function createGenerateTextResult(output: unknown): GenerateTextResult {
  return {
    text: "",
    files: [],
    sources: [],
    reasoning: undefined,
    reasoningDetails: [],
    toolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: "stop",
    usage: {
      inputTokens: 1,
      inputTokenDetails: {
        noCacheTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      },
      outputTokens: 1,
      outputTokenDetails: {
        textTokens: 1,
        reasoningTokens: 0
      },
      totalTokens: 2
    },
    warnings: undefined,
    request: {},
    response: {},
    providerMetadata: undefined,
    steps: [],
    output,
    toUIMessageStream() {
      throw new Error("not implemented");
    },
    toUIMessage() {
      throw new Error("not implemented");
    }
  } as GenerateTextResult;
}
