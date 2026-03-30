import type {
  ModuleArtifact,
  ModuleArtifactType,
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
    try {
      this.insertTrace(trace);
    } catch (error) {
      if (!isMissingDescriptionVersionColumnError(error)) {
        throw error;
      }

      this.ensureDescriptionVersionColumns();
      this.insertTrace(trace);
    }
  }

  async finishTrace(
    traceId: string,
    update: Partial<Omit<ModuleTrace, "traceId">>
  ): Promise<void> {
    this.ensureSchema();
    const existing = this.sql`
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
        input_field_descriptions_version = ${asSqlStringOrNull(
          merged.input_field_descriptions_version
        )},
        output_field_descriptions_version = ${asSqlStringOrNull(
          merged.output_field_descriptions_version
        )},
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

  async saveArtifact(artifact: ModuleArtifact): Promise<void> {
    this.ensureSchema();
    this.sql`
      INSERT INTO module_artifacts (
        artifact_id, module_path, artifact_type, version, content_json,
        created_at, is_active
      ) VALUES (
        ${artifact.artifactId}, ${artifact.modulePath}, ${artifact.artifactType},
        ${artifact.version}, ${artifact.contentJson}, ${artifact.createdAt},
        ${artifact.isActive ? 1 : 0}
      )
    `;
  }

  async getActiveArtifact(
    modulePath: string,
    artifactType: ModuleArtifactType
  ): Promise<ModuleArtifact | null> {
    this.ensureSchema();
    const [artifact] = this.sql`
      SELECT
        artifact_id as artifactId,
        module_path as modulePath,
        artifact_type as artifactType,
        version,
        content_json as contentJson,
        created_at as createdAt,
        is_active as isActive
      FROM module_artifacts
      WHERE module_path = ${modulePath}
        AND artifact_type = ${artifactType}
        AND is_active = 1
      ORDER BY created_at DESC
      LIMIT 1
    ` as unknown as ModuleArtifact[];

    if (!artifact) {
      return null;
    }

    return {
      ...artifact,
      isActive: Boolean(artifact.isActive)
    };
  }

  async activateArtifact(
    modulePath: string,
    artifactType: ModuleArtifactType,
    artifactId: string
  ): Promise<void> {
    this.ensureSchema();
    this.sql`
      UPDATE module_artifacts
      SET is_active = 0
      WHERE module_path = ${modulePath}
        AND artifact_type = ${artifactType}
    `;

    this.sql`
      UPDATE module_artifacts
      SET is_active = 1
      WHERE artifact_id = ${artifactId}
    `;
  }

  async getTraceEvents(
    traceId: string,
    options?: { limit?: number }
  ): Promise<ModuleTraceEvent[]> {
    this.ensureSchema();
    const limit = options?.limit ?? 100;
    return this.sql`
      SELECT
        event_id as eventId,
        trace_id as traceId,
        seq,
        visibility,
        kind,
        level,
        message,
        payload_json as payloadJson,
        created_at as createdAt
      FROM module_trace_events
      WHERE trace_id = ${traceId}
      ORDER BY seq ASC
      LIMIT ${limit}
    ` as unknown as ModuleTraceEvent[];
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
        input_field_descriptions_version as inputFieldDescriptionsVersion,
        output_field_descriptions_version as outputFieldDescriptionsVersion,
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
        input_field_descriptions_version TEXT,
        output_field_descriptions_version TEXT,
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

    this.ensureDescriptionVersionColumns();

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

  private insertTrace(trace: ModuleTrace) {
    this.sql`
      INSERT INTO module_traces (
        trace_id, module_path, signature_name, module_kind, status,
        input_json, output_json, input_hash, output_hash, model_id,
        adapter_name, instruction_version, context_version, demo_version,
        input_field_descriptions_version, output_field_descriptions_version,
        usage_json, latency_ms, error_json, created_at, finished_at
      ) VALUES (
        ${trace.traceId}, ${trace.modulePath}, ${trace.signatureName},
        ${trace.moduleKind}, ${trace.status}, ${trace.inputJson},
        ${trace.outputJson}, ${trace.inputHash}, ${trace.outputHash},
        ${trace.modelId}, ${trace.adapterName}, ${trace.instructionVersion},
        ${trace.contextVersion}, ${trace.demoVersion},
        ${trace.inputFieldDescriptionsVersion},
        ${trace.outputFieldDescriptionsVersion}, ${trace.usageJson},
        ${trace.latencyMs}, ${trace.errorJson}, ${trace.createdAt},
        ${trace.finishedAt}
      )
    `;
  }

  private ensureDescriptionVersionColumns() {
    this.ensureColumn(
      "module_traces",
      "input_field_descriptions_version",
      "TEXT"
    );
    this.ensureColumn(
      "module_traces",
      "output_field_descriptions_version",
      "TEXT"
    );
  }

  private ensureColumn(
    tableName: string,
    columnName: string,
    columnDefinition: string
  ) {
    const columns = runRawSql(this.sql, `PRAGMA table_info(${tableName})`);

    const hasColumn = columns.some((column) => column.name === columnName);
    if (hasColumn) {
      return;
    }

    runRawSql(
      this.sql,
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`
    );
  }
}

function toRowUpdate(
  update: Partial<Omit<ModuleTrace, "traceId">>
): Record<string, SqlPrimitive> {
  const rowUpdate: Record<string, SqlPrimitive> = {};

  if ("modulePath" in update) rowUpdate.module_path = update.modulePath ?? null;
  if ("signatureName" in update) {
    rowUpdate.signature_name = update.signatureName ?? null;
  }
  if ("moduleKind" in update) rowUpdate.module_kind = update.moduleKind ?? null;
  if ("status" in update) rowUpdate.status = update.status ?? null;
  if ("inputJson" in update) rowUpdate.input_json = update.inputJson ?? null;
  if ("outputJson" in update) rowUpdate.output_json = update.outputJson ?? null;
  if ("inputHash" in update) rowUpdate.input_hash = update.inputHash ?? null;
  if ("outputHash" in update) rowUpdate.output_hash = update.outputHash ?? null;
  if ("modelId" in update) rowUpdate.model_id = update.modelId ?? null;
  if ("adapterName" in update) {
    rowUpdate.adapter_name = update.adapterName ?? null;
  }
  if ("instructionVersion" in update) {
    rowUpdate.instruction_version = update.instructionVersion ?? null;
  }
  if ("inputFieldDescriptionsVersion" in update) {
    rowUpdate.input_field_descriptions_version =
      update.inputFieldDescriptionsVersion ?? null;
  }
  if ("outputFieldDescriptionsVersion" in update) {
    rowUpdate.output_field_descriptions_version =
      update.outputFieldDescriptionsVersion ?? null;
  }
  if ("contextVersion" in update) {
    rowUpdate.context_version = update.contextVersion ?? null;
  }
  if ("demoVersion" in update)
    rowUpdate.demo_version = update.demoVersion ?? null;
  if ("usageJson" in update) rowUpdate.usage_json = update.usageJson ?? null;
  if ("latencyMs" in update) rowUpdate.latency_ms = update.latencyMs ?? null;
  if ("errorJson" in update) rowUpdate.error_json = update.errorJson ?? null;
  if ("createdAt" in update) rowUpdate.created_at = update.createdAt ?? null;
  if ("finishedAt" in update) rowUpdate.finished_at = update.finishedAt ?? null;

  return rowUpdate;
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

function runRawSql(
  sql: SqlFn,
  statement: string
): Array<Record<string, unknown>> {
  return sql([statement] as unknown as TemplateStringsArray);
}

function isMissingDescriptionVersionColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("input_field_descriptions_version") ||
    error.message.includes("output_field_descriptions_version")
  );
}
