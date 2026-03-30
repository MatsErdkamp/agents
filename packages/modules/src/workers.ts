import {
  Workspace,
  createWorkspaceStateBackend,
  type StateBackend
} from "@cloudflare/shell";
import { stateToolsFromBackend } from "@cloudflare/shell/workers";
import type {
  RLMExecuteStepRequest,
  RLMExecuteStepResult,
  RLMPreparedContext,
  RLMResource,
  RLMRuntime,
  RLMSession
} from "./rlm-types";
import { isMediaInput } from "./media";
import { stableStringify, summarizeForStorage } from "./utils";

export interface ShellRLMRuntimeOptions {
  state?: StateBackend;
  workspace?: Workspace;
  loader?: WorkerLoader;
  executor?: Executor;
  providers?: ToolProvider[];
  timeout?: number;
  globalOutbound?: Fetcher | null;
  artifactBucket?: R2Bucket;
  artifactPrefix?: string;
}

export interface IngestRLMContextOptions {
  contextRoot?: string;
  inlineStringChars?: number;
  previewChars?: number;
  storeLargeText?: (
    name: string,
    value: string,
    path: string,
    previewChars: number
  ) => Promise<{ resource: RLMResource; write: ShellResourceWrite }>;
}

type ToolProvider = {
  name?: string;
  tools: Record<
    string,
    {
      execute: (args: unknown) => Promise<unknown>;
      description?: string;
      needsApproval?: boolean;
    }
  >;
  positionalArgs?: boolean;
};

type ResolvedProvider = {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  positionalArgs?: boolean;
};

type Executor = {
  execute(
    code: string,
    providers:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<{ result: unknown; error?: string; logs?: string[] }>;
};

type ShellResourceWrite = {
  path: string;
  content: string | Uint8Array;
  binary?: boolean;
};

type R2TextPointer = {
  storage: "r2";
  path: string;
  key: string;
  totalChars: number;
  preview: string;
};

export function createShellRLMRuntime(
  options: ShellRLMRuntimeOptions
): RLMRuntime {
  const backend =
    options.state ??
    (options.workspace
      ? createWorkspaceStateBackend(options.workspace)
      : undefined);
  if (!backend) {
    throw new Error(
      "createShellRLMRuntime requires either `state` or `workspace`."
    );
  }

  return {
    async createSession() {
      const executor = await resolveExecutor(options);
      return new ShellRLMSession(
        backend,
        executor,
        options.providers ?? [],
        options.artifactBucket,
        options.artifactPrefix
      );
    }
  };
}

export async function ingestRLMContextToState(
  input: Record<string, unknown>,
  backend: StateBackend,
  options?: IngestRLMContextOptions
): Promise<RLMPreparedContext> {
  const inlineStringChars = options?.inlineStringChars ?? 512;
  const previewChars = options?.previewChars ?? 240;
  const contextRoot = options?.contextRoot ?? "/context";
  const assetsRoot = `${contextRoot}/assets`;

  await resetPath(backend, contextRoot);
  await backend.mkdir(contextRoot, { recursive: true });
  await backend.mkdir(assetsRoot, { recursive: true });

  const resources: RLMResource[] = [];
  const writes: ShellResourceWrite[] = [];
  const smallInputs: Record<string, unknown> = {};

  const entries = Object.entries(input).sort(([left], [right]) =>
    left.localeCompare(right)
  );

  for (const [name, value] of entries) {
    if (isMediaInput(value)) {
      const resource = createMediaResource(
        name,
        value,
        assetsRoot,
        previewChars
      );
      resources.push(resource.resource);
      writes.push(resource.write);
      continue;
    }

    if (typeof value === "string") {
      if (value.length <= inlineStringChars) {
        smallInputs[name] = value;
        continue;
      }

      const path = options?.storeLargeText
        ? `${contextRoot}/${safePathSegment(name)}.r2.txt`
        : `${contextRoot}/${safePathSegment(name)}.txt`;
      if (options?.storeLargeText) {
        const stored = await options.storeLargeText(
          name,
          value,
          path,
          previewChars
        );
        writes.push(stored.write);
        resources.push(stored.resource);
        continue;
      }

      writes.push({ path, content: value });
      resources.push({
        name,
        path,
        kind: "text",
        valueType: "string",
        size: value.length,
        preview: truncatePreview(value, previewChars)
      });
      continue;
    }

    if (
      value == null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      smallInputs[name] = value;
      continue;
    }

    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const path = `${assetsRoot}/${safePathSegment(name)}.bin`;
      writes.push({ path, content: bytes, binary: true });
      resources.push({
        name,
        path,
        kind: "binary",
        valueType: value instanceof Uint8Array ? "Uint8Array" : "ArrayBuffer",
        size: bytes.byteLength,
        preview: `${bytes.byteLength} bytes`
      });
      continue;
    }

    const serialized = stableStringify(value);
    if (isRowArray(value)) {
      const path = `${contextRoot}/${safePathSegment(name)}.ndjson`;
      const lines = (value as unknown[]).map((entry) => JSON.stringify(entry));
      writes.push({ path, content: lines.join("\n") });
      resources.push({
        name,
        path,
        kind: "ndjson",
        valueType: "array",
        size: lines.length,
        preview: truncatePreview(lines.slice(0, 3).join("\n"), previewChars)
      });
      continue;
    }

    const path = `${contextRoot}/${safePathSegment(name)}.json`;
    writes.push({ path, content: serialized });
    resources.push({
      name,
      path,
      kind: "json",
      valueType: Array.isArray(value) ? "array" : "object",
      size: serialized.length,
      preview: truncatePreview(serialized, previewChars)
    });
  }

  if (Object.keys(smallInputs).length > 0) {
    const path = `${contextRoot}/inputs.json`;
    const content = stableStringify(smallInputs);
    writes.push({ path, content });
    resources.push({
      name: "inputs",
      path,
      kind: "input-index",
      valueType: "object",
      size: content.length,
      preview: truncatePreview(content, previewChars)
    });
  }

  for (const write of writes) {
    await ensureParentDirectory(backend, write.path);
    if (write.binary) {
      await backend.writeFileBytes(write.path, write.content as Uint8Array);
    } else {
      await backend.writeFile(write.path, write.content as string);
    }
  }

  const manifestPath = `${contextRoot}/_manifest.json`;
  const manifestContent = stableStringify({ contextRoot, resources });
  await backend.writeFile(manifestPath, manifestContent);

  return {
    contextRoot,
    manifestPath,
    resources,
    manifestSummary: formatManifestSummary(contextRoot, manifestPath, resources)
  };
}

class ShellRLMSession implements RLMSession {
  constructor(
    private readonly backend: StateBackend,
    private readonly executor: Executor,
    private readonly providers: ToolProvider[],
    private readonly artifactBucket?: R2Bucket,
    private readonly artifactPrefix?: string
  ) {}

  async prepareContext(
    input: Record<string, unknown>
  ): Promise<RLMPreparedContext> {
    return ingestRLMContextToState(input, this.backend, {
      contextRoot: `/context/${crypto.randomUUID()}`,
      storeLargeText: this.artifactBucket
        ? (name, value, path, previewChars) =>
            this.storeLargeTextInR2(name, value, path, previewChars)
        : undefined
    });
  }

  async executeStep(
    request: RLMExecuteStepRequest
  ): Promise<RLMExecuteStepResult> {
    let queryCallsUsed = request.queryCallsUsed;
    const r2TextCache = new Map<string, string>();
    const countQueryCalls = (count: number) => {
      const next = queryCallsUsed + count;
      if (next > request.maxQueryCalls) {
        throw new Error(
          `Query call limit exceeded: ${next} > ${request.maxQueryCalls}.`
        );
      }
      queryCallsUsed = next;
    };

    const queryProvider: ToolProvider = {
      name: "rlmtools",
      tools: {
        query: {
          description: "Semantic subquery over a snippet.",
          execute: async (args: unknown) => {
            const input = asRecord(args);
            const prompt = requireString(input.prompt, "prompt");
            const options = asQueryOptions(input.options);
            countQueryCalls(1);
            return request.queryProvider.query(prompt, options);
          }
        },
        queryBatch: {
          description: "Batched semantic subqueries.",
          execute: async (args: unknown) => {
            const input = asRecord(args);
            const prompts = requireStringArray(input.prompts, "prompts");
            const options = asQueryOptions(input.options);
            countQueryCalls(prompts.length);
            return request.queryProvider.batch(prompts, options);
          }
        }
      }
    };

    const r2TextProvider: ToolProvider = {
      name: "r2text",
      tools: {
        getInfo: {
          description: "Inspect an R2-backed text pointer file.",
          execute: async (args: unknown) => {
            const input = asRecord(args);
            return this.getR2TextInfo(requireString(input.path, "path"));
          }
        },
        read: {
          description: "Read an R2-backed text artifact.",
          execute: async (args: unknown) => {
            const input = asRecord(args);
            return this.readR2Text(
              requireString(input.path, "path"),
              {
                startChar: asOptionalNumber(input.startChar),
                maxChars: asOptionalNumber(input.maxChars)
              },
              r2TextCache
            );
          }
        },
        search: {
          description: "Search an R2-backed text artifact.",
          execute: async (args: unknown) => {
            const input = asRecord(args);
            return this.searchR2Text(
              requireString(input.path, "path"),
              requireString(input.query, "query"),
              {
                caseSensitive: input.caseSensitive === true,
                maxResults: asOptionalNumber(input.maxResults),
                contextChars: asOptionalNumber(input.contextChars)
              },
              r2TextCache
            );
          }
        },
        locateFractions: {
          description:
            "Map fractions to character offsets in an R2 text artifact.",
          execute: async (args: unknown) => {
            const input = asRecord(args);
            return this.locateR2TextFractions(
              requireString(input.path, "path"),
              requireNumberArray(input.fractions, "fractions")
            );
          }
        },
        readAtFraction: {
          description: "Read around a fraction of an R2 text artifact.",
          execute: async (args: unknown) => {
            const input = asRecord(args);
            return this.readR2TextAtFraction(
              requireString(input.path, "path"),
              requireNumber(input.fraction, "fraction"),
              {
                maxChars: asOptionalNumber(input.maxChars)
              },
              r2TextCache
            );
          }
        }
      }
    };

    const result = await this.executor.execute(
      buildStepProgram(request.code, request.context, request.scratch),
      [
        resolveProvider(stateToolsFromBackend(this.backend) as ToolProvider),
        resolveProvider(queryProvider),
        resolveProvider(r2TextProvider),
        ...this.providers.map((provider) => resolveProvider(provider))
      ]
    );

    const payload = asRecord(result.result);
    const scratch = asScratch(payload.scratch);
    const submitted = payload.submitted;

    return {
      scratch,
      submitted,
      error: result.error,
      logs: result.logs ?? [],
      queryCallsUsed
    };
  }

  async close(): Promise<void> {}

  private async storeLargeTextInR2(
    name: string,
    value: string,
    path: string,
    previewChars: number
  ): Promise<{ resource: RLMResource; write: ShellResourceWrite }> {
    if (!this.artifactBucket) {
      throw new Error("R2 artifact bucket is not configured.");
    }

    const key = buildR2ArtifactKey(
      this.artifactPrefix,
      path,
      `${safePathSegment(name)}.txt`
    );
    const preview = truncatePreview(value, previewChars);

    await this.artifactBucket.put(key, value, {
      httpMetadata: {
        contentType: "text/plain; charset=utf-8"
      },
      customMetadata: {
        path,
        totalChars: String(value.length)
      }
    });

    const pointer: R2TextPointer = {
      storage: "r2",
      path,
      key,
      totalChars: value.length,
      preview
    };

    return {
      resource: {
        name,
        path,
        kind: "r2-text",
        valueType: "string",
        size: value.length,
        preview
      },
      write: {
        path,
        content: stableStringify(pointer)
      }
    };
  }

  private async getR2TextInfo(path: string): Promise<R2TextPointer> {
    return this.readR2TextPointer(path);
  }

  private async readR2Text(
    path: string,
    options: { startChar?: number; maxChars?: number },
    cache: Map<string, string>
  ): Promise<{
    path: string;
    startChar: number;
    endChar: number;
    totalChars: number;
    truncated: boolean;
    text: string;
  }> {
    const pointer = await this.readR2TextPointer(path);
    const text = await this.loadR2Text(pointer, cache);
    const startChar = Math.max(
      0,
      Math.min(text.length, options.startChar ?? 0)
    );
    const maxChars = Math.max(1, options.maxChars ?? 16000);
    const endChar = Math.min(text.length, startChar + maxChars);
    return {
      path,
      startChar,
      endChar,
      totalChars: text.length,
      truncated: endChar < text.length,
      text: text.slice(startChar, endChar)
    };
  }

  private async searchR2Text(
    path: string,
    query: string,
    options: {
      caseSensitive?: boolean;
      maxResults?: number;
      contextChars?: number;
    },
    cache: Map<string, string>
  ): Promise<
    Array<{
      path: string;
      startChar: number;
      endChar: number;
      snippet: string;
    }>
  > {
    const pointer = await this.readR2TextPointer(path);
    const text = await this.loadR2Text(pointer, cache);
    const haystack = options.caseSensitive ? text : text.toLowerCase();
    const needle = options.caseSensitive ? query : query.toLowerCase();
    const maxResults = Math.max(1, options.maxResults ?? 20);
    const contextChars = Math.max(0, options.contextChars ?? 120);
    const matches: Array<{
      path: string;
      startChar: number;
      endChar: number;
      snippet: string;
    }> = [];

    if (!needle) {
      return matches;
    }

    let searchStart = 0;
    while (matches.length < maxResults) {
      const index = haystack.indexOf(needle, searchStart);
      if (index === -1) {
        break;
      }
      const startChar = Math.max(0, index - contextChars);
      const endChar = Math.min(
        text.length,
        index + needle.length + contextChars
      );
      matches.push({
        path,
        startChar: index,
        endChar: index + needle.length,
        snippet: text.slice(startChar, endChar)
      });
      searchStart = index + Math.max(needle.length, 1);
    }

    return matches;
  }

  private async locateR2TextFractions(
    path: string,
    fractions: number[]
  ): Promise<
    Array<{
      path: string;
      fraction: number;
      totalChars: number;
      targetCharOffset: number;
    }>
  > {
    const pointer = await this.readR2TextPointer(path);
    return fractions.map((rawFraction) => {
      const fraction = Math.max(0, Math.min(1, rawFraction));
      return {
        path,
        fraction,
        totalChars: pointer.totalChars,
        targetCharOffset: Math.floor(pointer.totalChars * fraction)
      };
    });
  }

  private async readR2TextAtFraction(
    path: string,
    fraction: number,
    options: { maxChars?: number },
    cache: Map<string, string>
  ): Promise<{
    path: string;
    fraction: number;
    totalChars: number;
    targetCharOffset: number;
    startChar: number;
    endChar: number;
    text: string;
  }> {
    const pointer = await this.readR2TextPointer(path);
    const text = await this.loadR2Text(pointer, cache);
    const normalizedFraction = Math.max(0, Math.min(1, fraction));
    const targetCharOffset = Math.floor(text.length * normalizedFraction);
    const maxChars = Math.max(1, options.maxChars ?? 4000);
    const half = Math.floor(maxChars / 2);
    const startChar = Math.max(0, targetCharOffset - half);
    const endChar = Math.min(text.length, startChar + maxChars);

    return {
      path,
      fraction: normalizedFraction,
      totalChars: text.length,
      targetCharOffset,
      startChar,
      endChar,
      text: text.slice(startChar, endChar)
    };
  }

  private async readR2TextPointer(path: string): Promise<R2TextPointer> {
    const raw = await this.backend.readFile(path);
    const parsed = JSON.parse(raw) as Partial<R2TextPointer>;
    if (
      parsed.storage !== "r2" ||
      typeof parsed.key !== "string" ||
      typeof parsed.path !== "string" ||
      typeof parsed.totalChars !== "number" ||
      typeof parsed.preview !== "string"
    ) {
      throw new Error(`Invalid R2 text pointer at ${path}.`);
    }
    return parsed as R2TextPointer;
  }

  private async loadR2Text(
    pointer: R2TextPointer,
    cache: Map<string, string>
  ): Promise<string> {
    if (!this.artifactBucket) {
      throw new Error("R2 artifact bucket is not configured.");
    }
    const cached = cache.get(pointer.key);
    if (cached != null) {
      return cached;
    }
    const object = await this.artifactBucket.get(pointer.key);
    if (!object) {
      throw new Error(`R2 artifact not found for ${pointer.path}.`);
    }
    const text = await object.text();
    cache.set(pointer.key, text);
    return text;
  }
}

function buildStepProgram(
  code: string,
  context: RLMPreparedContext,
  scratch: Record<string, unknown>
): string {
  return `async () => {
  const scratch = ${stableStringify(scratch)};
  const CONTEXT_ROOT = ${JSON.stringify(context.contextRoot)};
  class __RLMSubmit extends Error {
    constructor(payload) {
      super("RLM_SUBMIT");
      this.payload = payload;
    }
  }
  const SUBMIT = (payload) => {
    throw new __RLMSubmit(payload);
  };
  const query = (prompt, options) => rlmtools.query({ prompt, options });
  const queryBatch = (prompts, options) =>
    rlmtools.queryBatch({ prompts, options });
  const getR2TextInfo = async (path) => r2text.getInfo({ path });
  const readR2Text = async (path, options) => r2text.read({ path, ...options });
  const searchR2Text = async (path, queryText, options) =>
    r2text.search({ path, query: queryText, ...options });
  const locateR2TextFractions = async (path, fractions) =>
    r2text.locateFractions({ path, fractions });
  const readR2TextAtFraction = async (path, fraction, options) =>
    r2text.readAtFraction({ path, fraction, ...options });
  try {
${indentCode(code, 4)}
    return { scratch };
  } catch (error) {
    if (error instanceof __RLMSubmit) {
      return { scratch, submitted: error.payload };
    }
    throw error;
  }
}`;
}

function indentCode(code: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return code
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatManifestSummary(
  contextRoot: string,
  manifestPath: string,
  resources: RLMResource[]
): string {
  const lines = [
    `Context root: ${contextRoot}`,
    `Manifest path: ${manifestPath}`,
    "Resources:"
  ];

  for (const resource of resources) {
    lines.push(
      `- ${resource.name}: ${resource.kind} at ${resource.path} (${resource.size})`
    );
    lines.push(`  preview: ${resource.preview}`);
  }

  return lines.join("\n");
}

async function resetPath(backend: StateBackend, path: string): Promise<void> {
  if (await backend.exists(path)) {
    await backend.removeTree(path);
  }
}

async function ensureParentDirectory(
  backend: StateBackend,
  path: string
): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  if (parent !== "/") {
    await backend.mkdir(parent, { recursive: true });
  }
}

function safePathSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "resource";
}

function truncatePreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function buildR2ArtifactKey(
  prefix: string | undefined,
  path: string,
  fallbackName: string
): string {
  const normalizedPrefix = prefix?.replace(/^\/+|\/+$/g, "");
  const basePath = path.replace(/^\/+/, "");
  const fileName = safePathSegment(fallbackName).replace(/-txt$/, ".txt");
  return [normalizedPrefix, basePath, `${crypto.randomUUID()}-${fileName}`]
    .filter(Boolean)
    .join("/");
}

function isRowArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
    )
  );
}

function createMediaResource(
  name: string,
  value: {
    type: "image" | "file" | "audio";
  } & Record<string, unknown>,
  assetsRoot: string,
  previewChars: number
): { resource: RLMResource; write: ShellResourceWrite } {
  const baseName = safePathSegment(
    typeof value.filename === "string" ? value.filename : name
  );

  if ("url" in value && typeof value.url === "string") {
    const path = `${assetsRoot}/${baseName}.url`;
    return {
      resource: {
        name,
        path,
        kind: "url",
        valueType: value.type,
        size: value.url.length,
        preview: truncatePreview(value.url, previewChars)
      },
      write: {
        path,
        content: value.url
      }
    };
  }

  const extension = extensionForMediaType(
    typeof value.mediaType === "string" ? value.mediaType : undefined
  );
  const path = `${assetsRoot}/${baseName}${extension}`;
  const content = normalizeBinary(value.data);
  return {
    resource: {
      name,
      path,
      kind: "binary",
      valueType: value.type,
      size: content.byteLength,
      preview:
        typeof value.mediaType === "string"
          ? `${value.mediaType}, ${content.byteLength} bytes`
          : `${content.byteLength} bytes`
    },
    write: {
      path,
      content,
      binary: true
    }
  };
}

function normalizeBinary(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return bytes;
  }
  return new TextEncoder().encode(String(summarizeForStorage(value)));
}

function extensionForMediaType(mediaType?: string): string {
  if (!mediaType) {
    return ".bin";
  }
  if (mediaType.includes("json")) {
    return ".json";
  }
  if (mediaType.includes("png")) {
    return ".png";
  }
  if (mediaType.includes("jpeg")) {
    return ".jpg";
  }
  if (mediaType.includes("gif")) {
    return ".gif";
  }
  if (mediaType.includes("wav")) {
    return ".wav";
  }
  if (mediaType.includes("mpeg")) {
    return ".mp3";
  }
  return ".bin";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asScratch(value: unknown): Record<string, unknown> {
  return asRecord(value);
}

function asQueryOptions(
  value: unknown
): { label?: string; metadata?: Record<string, unknown> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    label: typeof record.label === "string" ? record.label : undefined,
    metadata:
      record.metadata &&
      typeof record.metadata === "object" &&
      !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : undefined
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${field} to be a finite number.`);
  }
  return value;
}

function requireNumberArray(value: unknown, field: string): number[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    throw new Error(`Expected ${field} to be a number array.`);
  }
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Expected ${field} to be a string array.`);
  }
  return value;
}

async function resolveExecutor(
  options: ShellRLMRuntimeOptions
): Promise<Executor> {
  if (options.executor) {
    return options.executor;
  }

  if (!options.loader) {
    throw new Error(
      "createShellRLMRuntime requires either `executor` or `loader`."
    );
  }

  const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
  return new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: options.timeout,
    globalOutbound: options.globalOutbound
  }) as Executor;
}

function resolveProvider(provider: ToolProvider): ResolvedProvider {
  const resolved: ResolvedProvider = {
    name: provider.name ?? "codemode",
    fns: {}
  };

  for (const [name, tool] of Object.entries(provider.tools)) {
    if (tool.needsApproval != null) {
      continue;
    }
    resolved.fns[name] = tool.execute;
  }

  if (provider.positionalArgs) {
    resolved.positionalArgs = true;
  }

  return resolved;
}
