import { generateText, Output } from "ai";
import type {
  GenerateTextOnToolCallFinishCallback,
  GenerateTextOnToolCallStartCallback,
  ModelMessage,
  ToolSet
} from "ai";
import type { z } from "zod";
import {
  isMediaInput,
  type AudioInput,
  type FileInput,
  type ImageInput
} from "./media";
import type { Signature } from "./signature";
import type { ModuleContext, TraceVisibility } from "./types";
import { stableStringify, stringifyForStorage } from "./utils";

type TraceRecorder = {
  setMetadata(metadata: Record<string, string | null>): void;
  append(
    visibility: TraceVisibility,
    kind: string,
    level: "info" | "warn" | "error",
    message: string,
    payload?: Record<string, unknown>
  ): Promise<void>;
};

type AdapterContext = ModuleContext & {
  trace: TraceRecorder;
};

export interface PredictAdapterResult<Result> {
  output: Result;
  metadata?: {
    modelId?: string | null;
    adapterName?: string | null;
    usageJson?: string | null;
  };
}

export interface PredictAdapter {
  readonly name: string;
  execute<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    context: AdapterContext,
    signature: Signature<I, O>,
    input: z.output<I>
  ): Promise<PredictAdapterResult<z.output<O>>>;
}

type GenerateTextFn = typeof generateText;

export class AISDKGenerateTextAdapter implements PredictAdapter {
  readonly name = "ai-sdk-generate-text";
  readonly #generateTextFn: GenerateTextFn;

  constructor(options?: { generateText?: GenerateTextFn }) {
    this.#generateTextFn = options?.generateText ?? generateText;
  }

  renderInput<I extends z.ZodTypeAny>(
    signature: Signature<I, z.ZodTypeAny>,
    input: z.output<I>
  ): {
    system: string | undefined;
    messages: ModelMessage[];
  } {
    return {
      system: buildSystemPrompt(signature),
      messages: [
        {
          role: "user",
          content: buildUserContent(signature.name, input)
        }
      ]
    };
  }

  async execute<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    context: AdapterContext,
    signature: Signature<I, O>,
    input: z.output<I>
  ): Promise<PredictAdapterResult<z.output<O>>> {
    const rendered = this.renderInput(signature, input);
    const result = await this.#generateTextFn({
      model: context.model,
      system: rendered.system,
      messages: rendered.messages,
      tools: context.tools,
      ...(context.maxOutputTokens != null
        ? { maxOutputTokens: context.maxOutputTokens }
        : {}),
      output: Output.object({
        schema: signature.output,
        name: signature.name,
        description: signature.instructions
      }),
      experimental_onToolCallStart: createToolCallStartHandler(context.trace),
      experimental_onToolCallFinish: createToolCallFinishHandler(context.trace)
    });

    const metadata = {
      modelId: describeModel(context.model),
      adapterName: this.name,
      usageJson: stringifyForStorage(result.usage)
    };

    context.trace.setMetadata(metadata);

    return {
      output: result.output as z.output<O>,
      metadata
    };
  }
}

function buildSystemPrompt(
  signature: Signature<z.ZodTypeAny, z.ZodTypeAny>
): string | undefined {
  const sections = [signature.instructions];
  const inputGuidance = formatFieldDescriptions(
    "Input field guidance",
    signature.inputFieldDescriptions
  );
  const outputGuidance = formatFieldDescriptions(
    "Output field guidance",
    signature.outputFieldDescriptions
  );

  if (inputGuidance) {
    sections.push(inputGuidance);
  }

  if (outputGuidance) {
    sections.push(outputGuidance);
  }

  const system = sections.filter(Boolean).join("\n\n");
  return system || undefined;
}

export const AISDKGenerateObjectAdapter = AISDKGenerateTextAdapter;

function buildUserContent(
  signatureName: string,
  input: unknown
): Array<
  | { type: "text"; text: string }
  | {
      type: "image";
      image: URL | string | Uint8Array | ArrayBuffer;
      mediaType?: string;
    }
  | {
      type: "file";
      data: URL | string | Uint8Array | ArrayBuffer;
      mediaType: string;
      filename?: string;
    }
> {
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        image: URL | string | Uint8Array | ArrayBuffer;
        mediaType?: string;
      }
    | {
        type: "file";
        data: URL | string | Uint8Array | ArrayBuffer;
        mediaType: string;
        filename?: string;
      }
  > = [{ type: "text", text: `signature: ${signatureName}` }];

  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    content.push({
      type: "text",
      text: `input:\n${formatPromptValue(input)}`
    });
    return content;
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isMediaInput(value)) {
      content.push({ type: "text", text: `${key}:` });
      content.push(renderMediaValue(value));
      continue;
    }

    content.push({
      type: "text",
      text: `${key}:\n${formatPromptValue(value)}`
    });
  }

  return content;
}

function formatFieldDescriptions(
  label: string,
  descriptions: Readonly<Record<string, string>>
): string | null {
  const entries = Object.entries(descriptions);

  if (entries.length === 0) {
    return null;
  }

  return [
    `${label}:`,
    ...entries.map(
      ([fieldPath, description]) => `- ${fieldPath}: ${description}`
    )
  ].join("\n");
}

function renderMediaValue(value: ImageInput | FileInput | AudioInput) {
  if (value.type === "image") {
    if ("url" in value) {
      return {
        type: "image" as const,
        image: new URL(value.url),
        mediaType: value.mediaType
      };
    }

    const data = normalizeBinaryContent(value.data);

    return {
      type: "image" as const,
      image: data.content,
      mediaType: value.mediaType ?? data.mediaType
    };
  }

  if ("url" in value) {
    return {
      type: "file" as const,
      data: new URL(value.url),
      mediaType: value.mediaType,
      filename: value.filename
    };
  }

  const data = normalizeBinaryContent(value.data);

  return {
    type: "file" as const,
    data: data.content,
    mediaType: value.mediaType ?? data.mediaType ?? "application/octet-stream",
    filename: value.filename
  };
}

function normalizeBinaryContent(content: string | Uint8Array | ArrayBuffer): {
  content: string | Uint8Array | ArrayBuffer;
  mediaType?: string;
} {
  if (typeof content !== "string") {
    return { content };
  }

  if (!content.startsWith("data:")) {
    return { content };
  }

  const parsed = parseDataUrl(content);
  return {
    content: parsed.bytes,
    mediaType: parsed.mediaType
  };
}

function parseDataUrl(value: string): {
  bytes: Uint8Array;
  mediaType?: string;
} {
  const match = /^data:([^;,]+)?(?:;base64)?,([\s\S]+)$/i.exec(value);

  if (!match) {
    return {
      bytes: stringToBytes(value)
    };
  }

  const [, mediaType, payload] = match;
  const isBase64 = value.includes(";base64,");
  const decoded = isBase64
    ? decodeBase64(payload)
    : decodeURIComponent(payload);

  return {
    bytes: stringToBytes(decoded),
    mediaType
  };
}

function decodeBase64(value: string): string {
  if (typeof atob === "function") {
    return atob(value);
  }

  return Buffer.from(value, "base64").toString("binary");
}

function stringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);

  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
  }

  return bytes;
}

function formatPromptValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return stableStringify(value);
}

function createToolCallStartHandler(
  trace: TraceRecorder
): GenerateTextOnToolCallStartCallback<ToolSet> {
  return async (event) => {
    await trace.append(
      "meta",
      "tool_call_started",
      "info",
      `Tool call started: ${event.toolCall.toolName}`,
      {
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        input: event.toolCall.input,
        stepNumber: event.stepNumber
      }
    );
  };
}

function createToolCallFinishHandler(
  trace: TraceRecorder
): GenerateTextOnToolCallFinishCallback<ToolSet> {
  return async (event) => {
    if (event.success) {
      await trace.append(
        "meta",
        "tool_call_succeeded",
        "info",
        `Tool call succeeded: ${event.toolCall.toolName}`,
        {
          toolName: event.toolCall.toolName,
          toolCallId: event.toolCall.toolCallId,
          output: event.output,
          stepNumber: event.stepNumber
        }
      );
      return;
    }

    await trace.append(
      "asi",
      "tool_call_failed",
      "warn",
      `Tool call failed: ${event.toolCall.toolName}`,
      {
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        error:
          event.error instanceof Error
            ? event.error.message
            : String(event.error),
        stepNumber: event.stepNumber
      }
    );
  };
}

function describeModel(model: ModuleContext["model"]): string {
  if (typeof model === "string") {
    return model;
  }

  if (
    typeof model === "object" &&
    model !== null &&
    "provider" in model &&
    "modelId" in model &&
    typeof model.provider === "string" &&
    typeof model.modelId === "string"
  ) {
    return `${model.provider}:${model.modelId}`;
  }

  if (
    typeof model === "object" &&
    model !== null &&
    "modelId" in model &&
    typeof model.modelId === "string"
  ) {
    return model.modelId;
  }

  return "unknown";
}
