import { generateText, type LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  ModuleTrace,
  Predict,
  signature,
  type PredictAdapter,
  type ModuleArtifact,
  type ModuleFeedback,
  type ModuleStore,
  type ModuleTraceEvent
} from "../../modules/src/index";
import { Evolve, ModuleTraceAdapter } from "../src/index";
import { AIME_STYLE_FIXTURES } from "./fixtures";

type Env = {
  AI: Ai;
};

const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

class MemoryModuleStore implements ModuleStore {
  readonly traces: ModuleTrace[] = [];
  readonly events: ModuleTraceEvent[] = [];
  readonly feedback: ModuleFeedback[] = [];
  readonly artifacts: ModuleArtifact[] = [];

  async beginTrace(trace: ModuleTrace): Promise<void> {
    this.traces.push(trace);
  }

  async finishTrace(
    traceId: string,
    update: Partial<Omit<ModuleTrace, "traceId">>
  ): Promise<void> {
    const index = this.traces.findIndex((trace) => trace.traceId === traceId);
    if (index >= 0) {
      this.traces[index] = { ...this.traces[index], ...update };
    }
  }

  async appendTraceEvent(event: ModuleTraceEvent): Promise<void> {
    this.events.push(event);
  }

  async saveFeedback(feedback: ModuleFeedback): Promise<void> {
    this.feedback.push(feedback);
  }

  async saveArtifact(artifact: ModuleArtifact): Promise<void> {
    this.artifacts.push(artifact);
  }

  async getActiveArtifact(
    modulePath: string,
    artifactType: ModuleArtifact["artifactType"]
  ): Promise<ModuleArtifact | null> {
    return (
      this.artifacts.find(
        (artifact) =>
          artifact.modulePath === modulePath &&
          artifact.artifactType === artifactType &&
          artifact.isActive
      ) ?? null
    );
  }

  async activateArtifact(
    modulePath: string,
    artifactType: ModuleArtifact["artifactType"],
    artifactId: string
  ): Promise<void> {
    for (const artifact of this.artifacts) {
      if (
        artifact.modulePath === modulePath &&
        artifact.artifactType === artifactType
      ) {
        artifact.isActive = artifact.artifactId === artifactId;
      }
    }
  }

  async getTraceEvents(
    traceId: string,
    options?: { limit?: number }
  ): Promise<ModuleTraceEvent[]> {
    return this.events
      .filter((event) => event.traceId === traceId)
      .slice(0, options?.limit ?? Number.POSITIVE_INFINITY);
  }

  async getTraces(
    modulePath: string,
    options?: { limit?: number }
  ): Promise<ModuleTrace[]> {
    return this.traces
      .filter((trace) => trace.modulePath === modulePath)
      .slice(0, options?.limit ?? Number.POSITIVE_INFINITY);
  }

  async getFeedback(options: {
    traceId?: string;
    traceIds?: string[];
    modulePath?: string;
    limit?: number;
  }): Promise<ModuleFeedback[]> {
    let result = this.feedback;

    if (options.traceId) {
      result = result.filter((entry) => entry.traceId === options.traceId);
    } else if (options.traceIds?.length) {
      const traceIds = new Set(options.traceIds);
      result = result.filter((entry) => traceIds.has(entry.traceId));
    } else if (options.modulePath) {
      const traceIds = new Set(
        this.traces
          .filter((trace) => trace.modulePath === options.modulePath)
          .map((trace) => trace.traceId)
      );
      result = result.filter((entry) => traceIds.has(entry.traceId));
    }

    return result.slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  }

  async getTraceBundle(
    traceId: string,
    options?: { eventLimit?: number; feedbackLimit?: number }
  ) {
    const trace = this.traces.find((entry) => entry.traceId === traceId);
    if (!trace) {
      return null;
    }

    return {
      trace,
      events: (await this.getTraceEvents(traceId, {
        limit: options?.eventLimit
      })) as ModuleTraceEvent[],
      feedback: await this.getFeedback({
        traceId,
        limit: options?.feedbackLimit
      })
    };
  }

  async listModulePaths(): Promise<string[]> {
    return [...new Set(this.traces.map((trace) => trace.modulePath))];
  }
}

const solveSignature = signature("solveMath")
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
  .withInstructions(
    'Solve the problem, but always put "0" in the answer field.'
  );

function normalizeAnswer(value: string): string {
  return value.trim().replace(/[^\d-]/g, "");
}

class PlainTextAnswerAdapter implements PredictAdapter {
  readonly name = "workers-ai-plain-text";

  async execute(
    context: {
      model: LanguageModel;
      maxOutputTokens?: number;
      trace: {
        setMetadata(metadata: Record<string, string | null>): void;
      };
    },
    signatureShape: typeof solveSignature,
    input: z.infer<typeof solveSignature.input>
  ) {
    const result = await generateText({
      model: context.model,
      system: [
        signatureShape.instructions,
        "Return only the exact numeric answer. Do not return JSON."
      ]
        .filter(Boolean)
        .join("\n\n"),
      prompt: `Problem: ${input.problem}`,
      maxOutputTokens: context.maxOutputTokens ?? 64,
      temperature: 0
    });

    const answer = normalizeAnswer(result.text) || result.text.trim();
    const usageJson =
      result.usage == null ? null : JSON.stringify(result.usage);
    context.trace.setMetadata({
      modelId: MODEL_ID,
      adapterName: this.name,
      usageJson
    });

    return {
      output: {
        answer
      },
      metadata: {
        modelId: MODEL_ID,
        adapterName: this.name,
        usageJson
      }
    };
  }
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
    prompt: options.prompt,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens ?? 700
  });

  const json = extractFirstJsonObject(response.text);
  const parsed = json
    ? (JSON.parse(json) as {
        summary?: string;
        instructions?: string;
        rationale?: string[];
      })
    : null;
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
              "The stored ASI and feedback indicate the instruction should return the exact numeric answer."
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

async function seedRuntimeData(
  module: Predict<typeof solveSignature.input, typeof solveSignature.output>,
  store: MemoryModuleStore,
  model: ReturnType<ReturnType<typeof createWorkersAI>>
) {
  for (const fixture of AIME_STYLE_FIXTURES) {
    const run = await module.invokeWithTrace(
      {
        model,
        store,
        maxOutputTokens: 256
      },
      {
        problem: fixture.problem
      }
    );

    const normalizedAnswer = normalizeAnswer(run.output.answer);
    const correct = normalizedAnswer === fixture.expectedAnswer;

    await store.appendTraceEvent({
      eventId: crypto.randomUUID(),
      traceId: run.traceId,
      seq: 1,
      visibility: "asi",
      kind: "wrong_answer",
      level: correct ? "info" : "warn",
      message: correct
        ? `The answer ${normalizedAnswer} matched the expected result.`
        : `The answer should be ${fixture.expectedAnswer}, but the current instructions forced ${normalizedAnswer || "(blank)"}. Rewrite the instructions so the model returns the exact numeric answer instead of 0.`,
      payloadJson: JSON.stringify({
        expectedAnswer: fixture.expectedAnswer,
        actualAnswer: normalizedAnswer
      }),
      createdAt: Date.now()
    });

    await store.saveFeedback({
      id: crypto.randomUUID(),
      traceId: run.traceId,
      score: correct ? 1 : 0,
      label: correct ? "correct" : "incorrect",
      comment: JSON.stringify({
        expectedAnswer: fixture.expectedAnswer,
        diagnosis:
          'The instruction "always put 0 in the answer field" must be removed. The model should compute and return the exact numeric answer.'
      }),
      createdAt: Date.now()
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname !== "/optimize") {
      return new Response("Not found", { status: 404 });
    }

    const workersai = createWorkersAI({ binding: env.AI });
    const taskModel = workersai(MODEL_ID, {
      sessionAffinity: "evolve-e2e-task"
    });
    const reflectionModel = workersai(MODEL_ID, {
      sessionAffinity: "evolve-e2e-reflection"
    });
    const store = new MemoryModuleStore();
    const module = new Predict(solveSignature, {
      adapter: new PlainTextAnswerAdapter()
    });

    await seedRuntimeData(module, store, taskModel);

    const adapter = new ModuleTraceAdapter({
      score: ({ example, output }) => {
        const expected = JSON.parse(example.feedback[0]?.comment ?? "{}") as {
          expectedAnswer?: string;
        };
        const actual =
          output != null &&
          typeof output === "object" &&
          "answer" in output &&
          typeof (output as { answer?: unknown }).answer === "string"
            ? normalizeAnswer((output as { answer: string }).answer)
            : "";

        return actual === expected.expectedAnswer ? 1 : 0;
      }
    });
    const evolve = new Evolve({
      generateText: generateReflectionObject as typeof import("ai").generateText
    });
    const result = await evolve.optimize({
      module,
      store,
      reflectionModel,
      executionContext: {
        model: taskModel,
        maxOutputTokens: 256
      },
      adapter,
      activate: true,
      maxIterations: 2,
      minibatchSize: 2,
      validationSplit: 0.34,
      limitPerModule: 10
    });

    const activeInstructionsArtifact = await store.getActiveArtifact(
      "solveMath",
      "instructions"
    );

    return Response.json({
      seedScore: result.seedCandidate.validationScore,
      bestScore: result.bestCandidate.validationScore,
      candidateCount: result.candidates.length,
      winningInstructions: result.bestCandidate.instructions,
      activatedArtifactId: result.appliedArtifacts.instructions ?? null,
      activeInstructions:
        activeInstructionsArtifact == null
          ? null
          : JSON.parse(activeInstructionsArtifact.contentJson),
      archive: result.archive,
      fixtures: AIME_STYLE_FIXTURES.length
    });
  }
};
