import type { LanguageModel, ToolSet } from "ai";

export type TraceVisibility = "asi" | "meta";

export type ModuleTraceStatus =
  | "running"
  | "success"
  | "error"
  | "validation_error";

export interface ModuleTrace {
  traceId: string;
  modulePath: string;
  signatureName: string;
  moduleKind: string;
  status: ModuleTraceStatus;
  inputJson: string | null;
  outputJson: string | null;
  inputHash: string | null;
  outputHash: string | null;
  modelId: string | null;
  adapterName: string | null;
  instructionVersion: string | null;
  inputFieldDescriptionsVersion: string | null;
  outputFieldDescriptionsVersion: string | null;
  contextVersion: string | null;
  demoVersion: string | null;
  usageJson: string | null;
  latencyMs: number | null;
  errorJson: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface ModuleTraceEvent {
  eventId: string;
  traceId: string;
  seq: number;
  visibility: TraceVisibility;
  kind: string;
  level: "info" | "warn" | "error";
  message: string;
  payloadJson: string | null;
  createdAt: number;
}

export interface ModuleFeedback {
  id: string;
  traceId: string;
  score: number | null;
  label: string | null;
  comment: string | null;
  createdAt: number;
}

export type ModuleArtifactType =
  | "instructions"
  | "input-field-descriptions"
  | "output-field-descriptions";

export interface ModuleArtifact {
  artifactId: string;
  modulePath: string;
  artifactType: ModuleArtifactType;
  version: string;
  contentJson: string;
  createdAt: number;
  isActive: boolean;
}

export interface ModuleStore {
  beginTrace(trace: ModuleTrace): Promise<void>;
  finishTrace(
    traceId: string,
    update: Partial<Omit<ModuleTrace, "traceId">>
  ): Promise<void>;
  appendTraceEvent(event: ModuleTraceEvent): Promise<void>;
  saveFeedback(feedback: ModuleFeedback): Promise<void>;
  saveArtifact(artifact: ModuleArtifact): Promise<void>;
  getActiveArtifact(
    modulePath: string,
    artifactType: ModuleArtifactType
  ): Promise<ModuleArtifact | null>;
  activateArtifact(
    modulePath: string,
    artifactType: ModuleArtifactType,
    artifactId: string
  ): Promise<void>;
  getTraceEvents(
    traceId: string,
    options?: { limit?: number }
  ): Promise<ModuleTraceEvent[]>;
  getTraces(
    modulePath: string,
    options?: { limit?: number }
  ): Promise<ModuleTrace[]>;
}

export interface ModuleASI {
  log(message: string, payload?: Record<string, unknown>): void;
  warn(message: string, payload?: Record<string, unknown>): void;
  error(message: string, payload?: Record<string, unknown>): void;
  metric(name: string, value: number, payload?: Record<string, unknown>): void;
}

export interface ModuleContext {
  model: LanguageModel;
  tools?: ToolSet;
  host?: unknown;
  session?: unknown;
  store?: ModuleStore;
  emit?: (type: string, payload?: Record<string, unknown>) => void;
  asi?: ModuleASI;
  maxOutputTokens?: number;
}
