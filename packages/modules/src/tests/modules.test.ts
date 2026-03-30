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
} from "..";
import type {
  ModuleContext,
  ModuleStore,
  ModuleTrace,
  ModuleTraceEvent
} from "..";

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

describe("predict signature builder", () => {
  it("preserves zod input and output types", () => {
    const sig = signature("classifyQuery")
      .withInput(z.object({ query: z.string() }))
      .withOutput(z.object({ category: z.string() }))
      .describeInputField("query", "The raw customer request to classify.")
      .describeOutputField("category", "The best category for the request.")
      .withInstructions("Classify the query.");

    expect(sig.name).toBe("classifyQuery");
    expect(sig.instructions).toBe("Classify the query.");
    expect(sig.inputFieldDescriptions.query).toBe(
      "The raw customer request to classify."
    );
    expect(sig.outputFieldDescriptions.category).toBe(
      "The best category for the request."
    );
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
      .describeInputField("question", "The question to answer about the image.")
      .describeOutputField("answer", "A direct answer to the question.")
      .withInstructions("Describe the image.");

    const adapter = new AISDKGenerateTextAdapter();
    const rendered = adapter.renderInput(sig, {
      question: "What is in this image?",
      screenshot: {
        type: "image",
        url: "https://example.com/cat.png"
      }
    });

    expect(rendered.system).toContain("Describe the image.");
    expect(rendered.system).toContain("Input field guidance:");
    expect(rendered.system).toContain(
      "question: The question to answer about the image."
    );
    expect(rendered.system).toContain("Output field guidance:");
    expect(rendered.system).toContain(
      "answer: A direct answer to the question."
    );
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

  it("decodes data url image inputs into bytes", () => {
    const sig = signature("describeImage")
      .withInput(
        z.object({
          question: z.string(),
          screenshot: image()
        })
      )
      .withOutput(z.object({ answer: z.string() }));

    const adapter = new AISDKGenerateTextAdapter();
    const rendered = adapter.renderInput(sig, {
      question: "What is in this image?",
      screenshot: {
        type: "image",
        data: "data:image/png;base64,SGVsbG8=",
        mediaType: "image/png"
      }
    });

    const [message] = rendered.messages;

    if (!Array.isArray(message.content)) {
      throw new Error("Expected array content");
    }

    expect(message.content[3]).toMatchObject({
      type: "image",
      mediaType: "image/png"
    });
    expect(message.content[3]).toHaveProperty("image");
    expect(message.content[3]?.type).toBe("image");

    const imagePart = message.content[3];
    if (
      imagePart?.type !== "image" ||
      !(imagePart.image instanceof Uint8Array)
    ) {
      throw new Error("Expected data url image to be decoded into bytes");
    }

    expect(Array.from(imagePart.image)).toEqual([72, 101, 108, 108, 111]);
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
      inputFieldDescriptionsVersion: "default",
      outputFieldDescriptionsVersion: "default",
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

  it("preserves module identity fields when finishing traces", async () => {
    const tracesById = new Map<string, Record<string, unknown>>();

    const sql = (
      strings: TemplateStringsArray,
      ...values: Array<string | number | boolean | null>
    ) => {
      const query = strings.reduce(
        (result, chunk, index) =>
          `${result}${chunk}${values[index] === undefined ? "" : "?"}`,
        ""
      );

      if (query.includes("INSERT INTO module_traces")) {
        tracesById.set(String(values[0]), {
          trace_id: values[0],
          module_path: values[1],
          signature_name: values[2],
          module_kind: values[3],
          status: values[4],
          input_json: values[5],
          output_json: values[6],
          input_hash: values[7],
          output_hash: values[8],
          model_id: values[9],
          adapter_name: values[10],
          instruction_version: values[11],
          context_version: values[12],
          demo_version: values[13],
          input_field_descriptions_version: values[14],
          output_field_descriptions_version: values[15],
          usage_json: values[16],
          latency_ms: values[17],
          error_json: values[18],
          created_at: values[19],
          finished_at: values[20]
        });
        return [];
      }

      if (query.includes("SELECT * FROM module_traces WHERE trace_id = ?")) {
        const row = tracesById.get(String(values[0]));
        return row ? [row] : [];
      }

      if (query.includes("UPDATE module_traces")) {
        tracesById.set(String(values[20]), {
          trace_id: values[20],
          module_path: values[0],
          signature_name: values[1],
          module_kind: values[2],
          status: values[3],
          input_json: values[4],
          output_json: values[5],
          input_hash: values[6],
          output_hash: values[7],
          model_id: values[8],
          adapter_name: values[9],
          instruction_version: values[10],
          context_version: values[11],
          demo_version: values[12],
          input_field_descriptions_version: values[13],
          output_field_descriptions_version: values[14],
          usage_json: values[15],
          latency_ms: values[16],
          error_json: values[17],
          created_at: values[18],
          finished_at: values[19]
        });
        return [];
      }

      if (
        query.includes("SELECT") &&
        query.includes("FROM module_traces") &&
        query.includes("WHERE module_path = ?")
      ) {
        const modulePath = String(values[0]);
        return [...tracesById.values()]
          .filter((trace) => trace.module_path === modulePath)
          .map((trace) => ({
            traceId: trace.trace_id,
            modulePath: trace.module_path,
            signatureName: trace.signature_name,
            moduleKind: trace.module_kind,
            status: trace.status,
            inputJson: trace.input_json,
            outputJson: trace.output_json,
            inputHash: trace.input_hash,
            outputHash: trace.output_hash,
            modelId: trace.model_id,
            adapterName: trace.adapter_name,
            instructionVersion: trace.instruction_version,
            inputFieldDescriptionsVersion:
              trace.input_field_descriptions_version,
            outputFieldDescriptionsVersion:
              trace.output_field_descriptions_version,
            contextVersion: trace.context_version,
            demoVersion: trace.demo_version,
            usageJson: trace.usage_json,
            latencyMs: trace.latency_ms,
            errorJson: trace.error_json,
            createdAt: trace.created_at,
            finishedAt: trace.finished_at
          }));
      }

      return [];
    };

    const store = new SqliteModuleStore(sql);

    await store.beginTrace({
      traceId: "trace-2",
      modulePath: "supportWorkflow.classify",
      signatureName: "supportWorkflow.classify",
      moduleKind: "predict",
      status: "running",
      inputJson: '{"query":"refund me"}',
      outputJson: null,
      inputHash: "input-hash",
      outputHash: null,
      modelId: null,
      adapterName: null,
      instructionVersion: "default",
      inputFieldDescriptionsVersion: "default",
      outputFieldDescriptionsVersion: "default",
      contextVersion: "default",
      demoVersion: "default",
      usageJson: null,
      latencyMs: null,
      errorJson: null,
      createdAt: 1,
      finishedAt: null
    });

    await store.finishTrace("trace-2", {
      status: "success",
      outputJson: '{"category":"refund"}',
      outputHash: "output-hash",
      latencyMs: 25,
      finishedAt: 2
    });

    const traces = await store.getTraces("supportWorkflow.classify");
    expect(traces).toHaveLength(1);
    expect(traces[0].modulePath).toBe("supportWorkflow.classify");
    expect(traces[0].status).toBe("success");
    expect(traces[0].outputJson).toContain("refund");
  });

  it("migrates existing module_traces tables with new description version columns", async () => {
    const statements: string[] = [];
    const columns = new Set([
      "trace_id",
      "module_path",
      "signature_name",
      "module_kind",
      "status",
      "input_json",
      "output_json",
      "input_hash",
      "output_hash",
      "model_id",
      "adapter_name",
      "instruction_version",
      "context_version",
      "demo_version",
      "usage_json",
      "latency_ms",
      "error_json",
      "created_at",
      "finished_at"
    ]);

    const sql = (
      strings: TemplateStringsArray,
      ...values: Array<string | number | boolean | null>
    ) => {
      const query = strings.reduce(
        (result, chunk, index) =>
          `${result}${chunk}${values[index] === undefined ? "" : "?"}`,
        ""
      );
      statements.push(query.trim());

      if (query.includes("PRAGMA table_info(module_traces)")) {
        return [...columns].map((name) => ({ name }));
      }

      if (
        query.includes(
          "ALTER TABLE module_traces ADD COLUMN input_field_descriptions_version TEXT"
        )
      ) {
        columns.add("input_field_descriptions_version");
        return [];
      }

      if (
        query.includes(
          "ALTER TABLE module_traces ADD COLUMN output_field_descriptions_version TEXT"
        )
      ) {
        columns.add("output_field_descriptions_version");
        return [];
      }

      return [];
    };

    new SqliteModuleStore(sql);

    expect(
      statements.some((statement) =>
        statement.includes(
          "ALTER TABLE module_traces ADD COLUMN input_field_descriptions_version TEXT"
        )
      )
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.includes(
          "ALTER TABLE module_traces ADD COLUMN output_field_descriptions_version TEXT"
        )
      )
    ).toBe(true);
  });

  it("retries trace insertion after adding missing description version columns", async () => {
    const columns = new Set([
      "trace_id",
      "module_path",
      "signature_name",
      "module_kind",
      "status",
      "input_json",
      "output_json",
      "input_hash",
      "output_hash",
      "model_id",
      "adapter_name",
      "instruction_version",
      "context_version",
      "demo_version",
      "usage_json",
      "latency_ms",
      "error_json",
      "created_at",
      "finished_at"
    ]);
    let insertAttempts = 0;

    const sql = (
      strings: TemplateStringsArray,
      ...values: Array<string | number | boolean | null>
    ) => {
      const query = strings.reduce(
        (result, chunk, index) =>
          `${result}${chunk}${values[index] === undefined ? "" : "?"}`,
        ""
      );

      if (query.includes("PRAGMA table_info(module_traces)")) {
        return [...columns].map((name) => ({ name }));
      }

      if (
        query.includes(
          "ALTER TABLE module_traces ADD COLUMN input_field_descriptions_version TEXT"
        )
      ) {
        columns.add("input_field_descriptions_version");
        return [];
      }

      if (
        query.includes(
          "ALTER TABLE module_traces ADD COLUMN output_field_descriptions_version TEXT"
        )
      ) {
        columns.add("output_field_descriptions_version");
        return [];
      }

      if (query.includes("INSERT INTO module_traces")) {
        insertAttempts += 1;

        if (!columns.has("input_field_descriptions_version")) {
          throw new Error(
            "table module_traces has no column named input_field_descriptions_version: SQLITE_ERROR"
          );
        }

        return [];
      }

      return [];
    };

    const store = new SqliteModuleStore(sql);

    await store.beginTrace({
      traceId: "trace-3",
      modulePath: "supportWorkflow",
      signatureName: "supportWorkflow",
      moduleKind: "module",
      status: "running",
      inputJson: "{}",
      outputJson: null,
      inputHash: "hash",
      outputHash: null,
      modelId: null,
      adapterName: null,
      instructionVersion: "default",
      inputFieldDescriptionsVersion: "default",
      outputFieldDescriptionsVersion: "default",
      contextVersion: "default",
      demoVersion: "default",
      usageJson: null,
      latencyMs: null,
      errorJson: null,
      createdAt: 1,
      finishedAt: null
    });

    expect(insertAttempts).toBeGreaterThanOrEqual(1);
    expect(columns.has("input_field_descriptions_version")).toBe(true);
    expect(columns.has("output_field_descriptions_version")).toBe(true);
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
    async saveArtifact() {},
    async getActiveArtifact() {
      return null;
    },
    async activateArtifact() {},
    async getTraceEvents(traceId) {
      return events.filter((event) => event.traceId === traceId);
    },
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
