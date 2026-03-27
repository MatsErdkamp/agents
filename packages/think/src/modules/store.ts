import type {
  ModuleFeedback,
  ModuleStore,
  ModuleTrace,
  ModuleTraceEvent
} from "./types";

type SqlPrimitive = string | number | boolean | null;

type SqlFn = (
  strings: TemplateStringsArray,
  ...values: SqlPrimitive[]
) => Array<Record<string, unknown>>;

export class SqliteModuleStore implements ModuleStore {
  #ready = false;

  constructor(private readonly sql: SqlFn) {
    this.ensureSchema();
  }

  async beginTrace(trace: ModuleTrace): Promise<void> {
    this.ensureSchema();
    this.sql`
      INSERT INTO module_traces (
        trace_id, module_path, signature_name, module_kind, status,
        input_json, output_json, input_hash, output_hash, model_id,
        adapter_name, instruction_version, context_version, demo_version,
        usage_json, latency_ms, error_json, created_at, finished_at
      ) VALUES (
        ${trace.traceId}, ${trace.modulePath}, ${trace.signatureName},
        ${trace.moduleKind}, ${trace.status}, ${trace.inputJson},
        ${trace.outputJson}, ${trace.inputHash}, ${trace.outputHash},
        ${trace.modelId}, ${trace.adapterName}, ${trace.instructionVersion},
        ${trace.contextVersion}, ${trace.demoVersion}, ${trace.usageJson},
        ${trace.latencyMs}, ${trace.errorJson}, ${trace.createdAt},
        ${trace.finishedAt}
      )
    `;
  }

  async finishTrace(
    traceId: string,
    update: Partial<Omit<ModuleTrace, "traceId">>
  ): Promise<void> {
    this.ensureSchema();
    const existing = this.sql<Record<string, unknown>>`
      SELECT * FROM module_traces WHERE trace_id = ${traceId}
    `;

    if (existing.length === 0) {
      return;
    }

    const merged = { ...existing[0], ...toRowUpdate(update) };

    this.sql`
      UPDATE module_traces
      SET
        module_path = ${asSqlString(merged.module_path)},
        signature_name = ${asSqlString(merged.signature_name)},
        module_kind = ${asSqlString(merged.module_kind)},
        status = ${asSqlString(merged.status)},
        input_json = ${asSqlStringOrNull(merged.input_json)},
        output_json = ${asSqlStringOrNull(merged.output_json)},
        input_hash = ${asSqlStringOrNull(merged.input_hash)},
        output_hash = ${asSqlStringOrNull(merged.output_hash)},
        model_id = ${asSqlStringOrNull(merged.model_id)},
        adapter_name = ${asSqlStringOrNull(merged.adapter_name)},
        instruction_version = ${asSqlStringOrNull(merged.instruction_version)},
        context_version = ${asSqlStringOrNull(merged.context_version)},
        demo_version = ${asSqlStringOrNull(merged.demo_version)},
        usage_json = ${asSqlStringOrNull(merged.usage_json)},
        latency_ms = ${asSqlNumberOrNull(merged.latency_ms)},
        error_json = ${asSqlStringOrNull(merged.error_json)},
        created_at = ${asSqlNumber(merged.created_at)},
        finished_at = ${asSqlNumberOrNull(merged.finished_at)}
      WHERE trace_id = ${traceId}
    `;
  }

  async appendTraceEvent(event: ModuleTraceEvent): Promise<void> {
    this.ensureSchema();
    this.sql`
      INSERT INTO module_trace_events (
        event_id, trace_id, seq, visibility, kind, level, message,
        payload_json, created_at
      ) VALUES (
        ${event.eventId}, ${event.traceId}, ${event.seq}, ${event.visibility},
        ${event.kind}, ${event.level}, ${event.message}, ${event.payloadJson},
        ${event.createdAt}
      )
    `;
  }

  async saveFeedback(feedback: ModuleFeedback): Promise<void> {
    this.ensureSchema();
    this.sql`
      INSERT INTO module_feedback (
        id, trace_id, score, label, comment, created_at
      ) VALUES (
        ${feedback.id}, ${feedback.traceId}, ${feedback.score},
        ${feedback.label}, ${feedback.comment}, ${feedback.createdAt}
      )
    `;
  }

  async getTraces(
    modulePath: string,
    options?: { limit?: number }
  ): Promise<ModuleTrace[]> {
    this.ensureSchema();
    const limit = options?.limit ?? 50;
    return this.sql`
      SELECT
        trace_id as traceId,
        module_path as modulePath,
        signature_name as signatureName,
        module_kind as moduleKind,
        status,
        input_json as inputJson,
        output_json as outputJson,
        input_hash as inputHash,
        output_hash as outputHash,
        model_id as modelId,
        adapter_name as adapterName,
        instruction_version as instructionVersion,
        context_version as contextVersion,
        demo_version as demoVersion,
        usage_json as usageJson,
        latency_ms as latencyMs,
        error_json as errorJson,
        created_at as createdAt,
        finished_at as finishedAt
      FROM module_traces
      WHERE module_path = ${modulePath}
      ORDER BY created_at DESC
      LIMIT ${limit}
    ` as unknown as ModuleTrace[];
  }

  private ensureSchema() {
    if (this.#ready) {
      return;
    }

    this.sql`
      CREATE TABLE IF NOT EXISTS module_traces (
        trace_id TEXT PRIMARY KEY,
        module_path TEXT NOT NULL,
        signature_name TEXT NOT NULL,
        module_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        input_hash TEXT,
        output_hash TEXT,
        model_id TEXT,
        adapter_name TEXT,
        instruction_version TEXT,
        context_version TEXT,
        demo_version TEXT,
        usage_json TEXT,
        latency_ms INTEGER,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_module_traces_module_path_created_at
      ON module_traces(module_path, created_at DESC)
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS module_trace_events (
        event_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        visibility TEXT NOT NULL,
        kind TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_module_trace_events_trace_seq
      ON module_trace_events(trace_id, seq)
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS module_feedback (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        score REAL,
        label TEXT,
        comment TEXT,
        created_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS module_artifacts (
        artifact_id TEXT PRIMARY KEY,
        module_path TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        version TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      )
    `;

    this.#ready = true;
  }
}

function toRowUpdate(
  update: Partial<Omit<ModuleTrace, "traceId">>
): Record<string, SqlPrimitive> {
  return {
    module_path: update.modulePath ?? null,
    signature_name: update.signatureName ?? null,
    module_kind: update.moduleKind ?? null,
    status: update.status ?? null,
    input_json: update.inputJson ?? null,
    output_json: update.outputJson ?? null,
    input_hash: update.inputHash ?? null,
    output_hash: update.outputHash ?? null,
    model_id: update.modelId ?? null,
    adapter_name: update.adapterName ?? null,
    instruction_version: update.instructionVersion ?? null,
    context_version: update.contextVersion ?? null,
    demo_version: update.demoVersion ?? null,
    usage_json: update.usageJson ?? null,
    latency_ms: update.latencyMs ?? null,
    error_json: update.errorJson ?? null,
    created_at: update.createdAt ?? null,
    finished_at: update.finishedAt ?? null
  };
}

function asSqlString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asSqlStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asSqlNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asSqlNumberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
