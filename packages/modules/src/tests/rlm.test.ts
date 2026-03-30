import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryStateBackend } from "@cloudflare/shell";
import type { PredictAdapter, PredictAdapterResult } from "../adapter";
import { RLM } from "../rlm";
import type {
  RLMPreparedContext,
  RLMQueryProvider,
  RLMRuntime,
  RLMSession
} from "../rlm-types";
import { signature } from "../signature";
import type {
  ModuleContext,
  ModuleStore,
  ModuleTrace,
  ModuleTraceEvent
} from "../types";
import { createShellRLMRuntime, ingestRLMContextToState } from "../workers";
import {
  createSubAgentQueryProvider,
  type RLMSubAgentQueryRequest
} from "../agents";

describe("RLM core loop", () => {
  it("submits structured output and traces the run", async () => {
    const traces: ModuleTrace[] = [];
    const events: ModuleTraceEvent[] = [];
    const store = createStore(traces, events);

    const actAdapter = createScriptedAdapter([
      {
        reasoning: "Inspect and submit.",
        code: "console.log('checked');\nSUBMIT({ answer: 'done' });"
      }
    ]);

    const runtime = createRuntime({
      preparedContext: defaultPreparedContext(),
      stepResults: [
        {
          scratch: { inspected: true },
          logs: ["checked"],
          queryCallsUsed: 1,
          submitted: { answer: "done" }
        }
      ]
    });

    const rlm = new RLM(
      signature("answerQuestion")
        .withInput(z.object({ question: z.string() }))
        .withOutput(z.object({ answer: z.string() }))
        .withInstructions("Answer the question using the shell context."),
      {
        runtime,
        queryProvider: silentQueryProvider(),
        actAdapter
      }
    );

    const result = await rlm.invoke(
      {
        model: "test:model",
        store
      } satisfies ModuleContext,
      { question: "What is the answer?" }
    );

    expect(result).toEqual({ answer: "done" });
    expect(traces.some((trace) => trace.moduleKind === "rlm")).toBe(true);
    expect(events.some((event) => event.kind === "rlm_context_prepared")).toBe(
      true
    );
    expect(events.some((event) => event.kind === "rlm_submitted")).toBe(true);
  });

  it("falls back to extract when SUBMIT payload is invalid", async () => {
    const extractInputs: unknown[] = [];
    const actAdapter = createScriptedAdapter([
      {
        reasoning: "Submit the wrong shape.",
        code: "SUBMIT({ wrong: true });"
      }
    ]);
    const extractAdapter = createScriptedAdapter(
      [{ answer: "fallback" }],
      extractInputs
    );

    const rlm = new RLM(
      signature("answerQuestion")
        .withInput(z.object({ question: z.string() }))
        .withOutput(z.object({ answer: z.string() })),
      {
        runtime: createRuntime({
          preparedContext: defaultPreparedContext(),
          stepResults: [
            {
              scratch: {},
              logs: ["attempted invalid submit"],
              queryCallsUsed: 0,
              submitted: { wrong: true }
            }
          ]
        }),
        queryProvider: silentQueryProvider(),
        actAdapter,
        extractAdapter,
        maxIterations: 1
      }
    );

    const result = await rlm.invoke(
      {
        model: "test:model"
      } satisfies ModuleContext,
      { question: "What is the answer?" }
    );

    expect(result).toEqual({ answer: "fallback" });
    expect(extractInputs).toHaveLength(1);
    expect((extractInputs[0] as { replHistory: string }).replHistory).toContain(
      "SUBMIT payload validation failed"
    );
  });
});

describe("shell-backed workers runtime", () => {
  it("ingests large inputs into the state backend and writes a manifest", async () => {
    const backend = createMemoryStateBackend();
    const longText = "a".repeat(700);

    const prepared = await ingestRLMContextToState(
      {
        shortLabel: "ok",
        document: longText,
        rows: [{ id: 1 }, { id: 2 }],
        config: { enabled: true }
      },
      backend,
      { contextRoot: "/context/test" }
    );

    expect(prepared.contextRoot).toBe("/context/test");
    expect(
      prepared.resources.find((resource) => resource.name === "document")?.path
    ).toBe("/context/test/document.txt");
    expect(
      prepared.resources.find((resource) => resource.kind === "ndjson")
    ).toBeDefined();
    expect(
      prepared.resources.find((resource) => resource.kind === "input-index")
    ).toBeDefined();

    await expect(backend.readFile("/context/test/document.txt")).resolves.toBe(
      longText
    );
    await expect(
      backend.readFile("/context/test/_manifest.json")
    ).resolves.toContain("document");
    expect(prepared.manifestSummary).not.toContain(longText);
  });

  it("builds a session with state and query providers and returns sandbox output", async () => {
    const backend = createMemoryStateBackend();
    const executor = new CapturingExecutor({
      result: {
        scratch: { seen: true },
        submitted: { answer: "ok" }
      },
      logs: ["sandbox complete"]
    });

    const runtime = createShellRLMRuntime({
      state: backend,
      executor
    });

    const session = await runtime.createSession();
    const prepared = await session.prepareContext({
      prompt: "hello",
      document: "x".repeat(600)
    });

    const result = await session.executeStep({
      code: "console.log(CONTEXT_ROOT);\nSUBMIT({ answer: 'ok' });",
      context: prepared,
      scratch: { step: 1 },
      queryProvider: silentQueryProvider(),
      maxQueryCalls: 4,
      queryCallsUsed: 0
    });

    expect(result.scratch).toEqual({ seen: true });
    expect(result.submitted).toEqual({ answer: "ok" });
    expect(result.logs).toEqual(["sandbox complete"]);
    expect(executor.capturedProviderNames).toEqual(["state", "rlmtools"]);
  });

  it("surfaces query budget errors through the runtime", async () => {
    const backend = createMemoryStateBackend();
    const executor = new QueryInvokingExecutor({
      prompts: ["a", "b", "c"]
    });

    const runtime = createShellRLMRuntime({
      state: backend,
      executor
    });

    const session = await runtime.createSession();
    const prepared = await session.prepareContext({
      document: "x".repeat(600)
    });
    const result = await session.executeStep({
      code: "await queryBatch(['a', 'b', 'c']);",
      context: prepared,
      scratch: {},
      queryProvider: silentQueryProvider(),
      maxQueryCalls: 2,
      queryCallsUsed: 0
    });

    expect(result.error).toContain("Query call limit exceeded");
  });
});

describe("sub-agent query provider", () => {
  it("fans out batched prompts and preserves result order", async () => {
    const subAgentCalls: string[] = [];
    const provider = createSubAgentQueryProvider({
      parent: {
        async subAgent(_cls, name) {
          subAgentCalls.push(name);
          return {
            async query(input: RLMSubAgentQueryRequest) {
              return `response:${input.prompt}`;
            }
          };
        }
      },
      childClass: class FakeQueryAgent {} as never
    });

    const results = await provider.batch(["first", "second"], {
      label: "semantic"
    });

    expect(results).toEqual(["response:first", "response:second"]);
    expect(subAgentCalls).toHaveLength(2);
    expect(subAgentCalls[0]).toContain("rlm-batch-0");
    expect(subAgentCalls[1]).toContain("rlm-batch-1");
  });
});

function createScriptedAdapter(
  outputs: unknown[],
  seenInputs?: unknown[]
): PredictAdapter {
  let index = 0;
  return {
    name: "scripted-adapter",
    async execute(
      _context,
      _signature,
      input
    ): Promise<PredictAdapterResult<never>> {
      seenInputs?.push(input);
      const output = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return {
        output: output as never,
        metadata: {
          adapterName: "scripted-adapter"
        }
      };
    }
  };
}

function defaultPreparedContext(): RLMPreparedContext {
  return {
    contextRoot: "/context/test",
    manifestPath: "/context/test/_manifest.json",
    resources: [
      {
        name: "document",
        path: "/context/test/document.txt",
        kind: "text",
        valueType: "string",
        size: 100,
        preview: "Preview"
      }
    ],
    manifestSummary:
      "Context root: /context/test\nManifest path: /context/test/_manifest.json"
  };
}

function createRuntime(options: {
  preparedContext: RLMPreparedContext;
  stepResults: Array<{
    scratch: Record<string, unknown>;
    logs: string[];
    queryCallsUsed: number;
    submitted?: unknown;
    error?: string;
  }>;
}): RLMRuntime {
  return {
    async createSession(): Promise<RLMSession> {
      const steps = [...options.stepResults];
      return {
        async prepareContext() {
          return options.preparedContext;
        },
        async executeStep() {
          const next = steps.shift();
          if (!next) {
            throw new Error("No scripted step result remaining.");
          }
          return next;
        },
        async close() {}
      };
    }
  };
}

function silentQueryProvider(): RLMQueryProvider {
  return {
    async query(prompt) {
      return `query:${prompt}`;
    },
    async batch(prompts) {
      return prompts.map((prompt) => `query:${prompt}`);
    }
  };
}

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
    async getTraceEvents() {
      return [];
    },
    async getTraces() {
      return [];
    }
  };
}

class CapturingExecutor {
  capturedProviderNames: string[] = [];

  constructor(
    private readonly response: {
      result: unknown;
      logs?: string[];
      error?: string;
    }
  ) {}

  async execute(
    _code: string,
    providersOrFns:
      | Array<{
          name: string;
          fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
        }>
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ) {
    if (!Array.isArray(providersOrFns)) {
      throw new Error("Expected resolved providers.");
    }
    this.capturedProviderNames = providersOrFns.map(
      (provider) => provider.name
    );
    return this.response;
  }
}

class QueryInvokingExecutor {
  constructor(private readonly options: { prompts: string[] }) {}

  async execute(
    _code: string,
    providersOrFns:
      | Array<{
          name: string;
          fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
        }>
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ) {
    if (!Array.isArray(providersOrFns)) {
      throw new Error("Expected resolved providers.");
    }

    const queryProvider = providersOrFns.find(
      (provider) => provider.name === "rlmtools"
    );
    if (!queryProvider) {
      throw new Error("Missing rlmtools provider.");
    }

    try {
      await queryProvider.fns.queryBatch({
        prompts: this.options.prompts
      });
      return { result: { scratch: {} } };
    } catch (error) {
      return {
        result: { scratch: {} },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
