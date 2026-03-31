import type { PredictAdapter } from "./adapter";

export type RLMResourceKind =
  | "text"
  | "json"
  | "ndjson"
  | "binary"
  | "r2-text"
  | "url"
  | "input-index";

export interface RLMResource {
  name: string;
  path: string;
  kind: RLMResourceKind;
  valueType: string;
  size: number;
  preview: string;
}

export interface RLMPreparedContext {
  contextRoot: string;
  manifestPath: string;
  resources: RLMResource[];
  manifestSummary: string;
}

export interface RLMQueryOptions {
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface RLMQueryProvider {
  query(prompt: string, options?: RLMQueryOptions): Promise<string>;
  batch(prompts: string[], options?: RLMQueryOptions): Promise<string[]>;
}

export interface RLMExecuteStepRequest {
  code: string;
  context: RLMPreparedContext;
  scratch: Record<string, unknown>;
  queryProvider: RLMQueryProvider;
  maxQueryCalls: number;
  queryCallsUsed: number;
}

export interface RLMExecuteStepResult {
  scratch: Record<string, unknown>;
  logs: string[];
  queryCallsUsed: number;
  submitted?: unknown;
  error?: string;
}

export interface RLMSession {
  prepareContext(input: Record<string, unknown>): Promise<RLMPreparedContext>;
  executeStep(request: RLMExecuteStepRequest): Promise<RLMExecuteStepResult>;
  close(): Promise<void>;
}

export interface RLMRuntime {
  createSession(): Promise<RLMSession>;
}

export interface RLMEntry {
  reasoning: string;
  code: string;
  output: string;
}

export class RLMHistory {
  readonly entries: readonly RLMEntry[];
  readonly maxOutputChars: number;

  constructor(
    entries: readonly RLMEntry[] = [],
    options?: { maxOutputChars?: number }
  ) {
    this.entries = entries;
    this.maxOutputChars = options?.maxOutputChars ?? 10_000;
  }

  append(entry: RLMEntry): RLMHistory {
    return new RLMHistory([...this.entries, entry], {
      maxOutputChars: this.maxOutputChars
    });
  }

  format(): string {
    if (this.entries.length === 0) {
      return "No REPL history yet.";
    }

    return this.entries
      .map((entry, index) => {
        return [
          `=== Step ${index + 1} ===`,
          `Reasoning: ${entry.reasoning || "(none)"}`,
          "Code:",
          "```javascript",
          entry.code,
          "```",
          formatRLMOutput(entry.output, this.maxOutputChars)
        ].join("\n");
      })
      .join("\n\n");
  }
}

export interface RLMOptions {
  runtime: RLMRuntime;
  queryProvider: RLMQueryProvider;
  maxIterations?: number;
  maxQueryCalls?: number;
  maxOutputChars?: number;
  verbose?: boolean;
  actAdapter?: PredictAdapter;
  extractAdapter?: PredictAdapter;
}

export function formatRLMOutput(
  output: string,
  maxOutputChars = 10_000
): string {
  const rawLength = output.length;
  if (rawLength <= maxOutputChars) {
    return `Output (${rawLength} chars):\n${output}`;
  }

  const head = Math.floor(maxOutputChars / 2);
  const tail = maxOutputChars - head;
  const omitted = rawLength - maxOutputChars;
  return [
    `Output (${rawLength} chars):`,
    output.slice(0, head),
    "",
    `... (${omitted} characters omitted) ...`,
    "",
    output.slice(rawLength - tail)
  ].join("\n");
}
