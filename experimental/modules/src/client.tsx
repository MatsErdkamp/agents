import "./styles.css";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Empty,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  BugBeetleIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  ImageIcon,
  MoonIcon,
  SparkleIcon,
  SunIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type {
  DescribeScreenshotResult,
  ModuleRunResponse,
  SupportWorkflowResult,
  TraceSummary
} from "./server";

let sessionId = localStorage.getItem("modules-experimental-session");
if (!sessionId) {
  sessionId = crypto.randomUUID().slice(0, 8);
  localStorage.setItem("modules-experimental-session", sessionId);
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";
  const text =
    status === "connected"
      ? "text-kumo-success"
      : status === "connecting"
        ? "text-kumo-warning"
        : "text-kumo-danger";

  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>
        {status === "connected"
          ? "Connected"
          : status === "connecting"
            ? "Connecting..."
            : "Disconnected"}
      </span>
    </div>
  );
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") || "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function JsonCard({ title, value }: { title: string; value: unknown }) {
  return (
    <Surface className="rounded-xl ring ring-kumo-line overflow-hidden">
      <div className="px-4 py-3 border-b border-kumo-line">
        <Text size="sm" bold>
          {title}
        </Text>
      </div>
      <pre className="m-0 p-4 text-xs overflow-x-auto text-kumo-default bg-kumo-base font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Surface>
  );
}

function TraceList({ traces }: { traces: TraceSummary[] }) {
  if (traces.length === 0) {
    return (
      <Empty
        icon={<BugBeetleIcon size={28} />}
        title="No traces yet"
        description="Run one of the modules to see durable trace summaries and ASI counts."
      />
    );
  }

  return (
    <div className="space-y-3">
      {traces.map((trace) => (
        <Surface
          key={trace.traceId}
          className="rounded-xl ring ring-kumo-line p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Text size="sm" bold>
                {trace.modulePath}
              </Text>
              <div className="mt-1 text-xs text-kumo-subtle">
                {new Date(trace.createdAt).toLocaleTimeString()} ·{" "}
                {trace.modelId ?? "unknown model"}
              </div>
            </div>
            <Badge
              variant={trace.status === "success" ? "success" : "secondary"}
            >
              {trace.status}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">latency {trace.latencyMs ?? 0}ms</Badge>
            <Badge variant="secondary">ASI {trace.asiEvents}</Badge>
            <Badge variant="secondary">meta {trace.metaEvents}</Badge>
          </div>
          {trace.latestAsiMessage && (
            <div className="text-xs text-kumo-warning">
              Latest ASI: {trace.latestAsiMessage}
            </div>
          )}
        </Surface>
      ))}
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [supportCustomer, setSupportCustomer] = useState("Acme, Inc.");
  const [supportQuery, setSupportQuery] = useState(
    "Our weekly billing export missed two invoices and finance is blocked. What should support do next?"
  );
  const [supportResult, setSupportResult] =
    useState<ModuleRunResponse<SupportWorkflowResult> | null>(null);
  const [supportLoading, setSupportLoading] = useState(false);

  const [visionQuestion, setVisionQuestion] = useState(
    "What should I mention in the alt text for this screenshot?"
  );
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageMediaType, setImageMediaType] = useState("image/png");
  const [imageFilename, setImageFilename] = useState<string | null>(null);
  const [visionResult, setVisionResult] =
    useState<ModuleRunResponse<DescribeScreenshotResult> | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent({
    agent: "ModulesExampleAgent",
    name: sessionId!,
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), [])
  });

  const runSupportWorkflow = async () => {
    setSupportLoading(true);
    setError(null);

    try {
      const result = (await agent.call("triageSupport", [
        {
          customer: supportCustomer,
          query: supportQuery
        }
      ])) as ModuleRunResponse<SupportWorkflowResult>;

      setSupportResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSupportLoading(false);
    }
  };

  const runVisionWorkflow = async () => {
    if (!imagePreview) {
      setError("Upload a screenshot first.");
      return;
    }

    setVisionLoading(true);
    setError(null);

    try {
      const result = (await agent.call("describeScreenshot", [
        {
          question: visionQuestion,
          screenshot: {
            type: "image",
            data: imagePreview,
            mediaType: imageMediaType,
            filename: imageFilename ?? undefined
          }
        }
      ])) as ModuleRunResponse<DescribeScreenshotResult>;

      setVisionResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setVisionLoading(false);
    }
  };

  const onImageChange = async (file: File | null) => {
    if (!file) {
      setImagePreview(null);
      setImageFilename(null);
      return;
    }

    setImageMediaType(file.type || "image/png");
    setImageFilename(file.name);

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    setImagePreview(dataUrl);
  };

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <SparkleIcon
                size={22}
                className="text-kumo-accent"
                weight="bold"
              />
              <h1 className="text-lg font-semibold text-kumo-default">
                Experimental Modules
              </h1>
              <Badge variant="secondary">@cloudflare/modules</Badge>
            </div>
            <p className="mt-1 text-sm text-kumo-subtle">
              An experimental sandbox for fluent signatures, `Predict`, composed
              modules, multimodal inputs, and durable trace summaries.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={status} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-6xl mx-auto grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-5">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-center gap-2">
                <ChatCircleTextIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Support Workflow Module
                </Text>
              </div>
              <p className="text-sm text-kumo-subtle m-0">
                This runs a composed module. The root module invokes a child
                `Predict` for classification, then a second child `Predict` for
                the handoff summary and reply.
              </p>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-kumo-subtle uppercase tracking-wide">
                  Customer
                </span>
                <input
                  className="w-full rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
                  value={supportCustomer}
                  onChange={(event) => setSupportCustomer(event.target.value)}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-kumo-subtle uppercase tracking-wide">
                  Support Request
                </span>
                <textarea
                  className="w-full min-h-36 rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
                  value={supportQuery}
                  onChange={(event) => setSupportQuery(event.target.value)}
                />
              </label>

              <div className="flex items-center gap-3">
                <Button
                  variant="primary"
                  size="sm"
                  loading={supportLoading}
                  onClick={runSupportWorkflow}
                >
                  Run support module
                </Button>
                <Badge variant="secondary">
                  Module + 2 child Predict calls
                </Badge>
              </div>

              {supportResult ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  <JsonCard
                    title="Structured Result"
                    value={supportResult.result}
                  />
                  <div className="space-y-3">
                    <Text size="sm" bold>
                      Recent Trace Summary
                    </Text>
                    <TraceList traces={supportResult.traces} />
                  </div>
                </div>
              ) : (
                <Empty
                  icon={<CheckCircleIcon size={30} />}
                  title="No support result yet"
                  description="Run the support workflow to see nested module output and trace rows."
                />
              )}
            </Surface>

            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-center gap-2">
                <ImageIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Multimodal Predict
                </Text>
              </div>
              <p className="text-sm text-kumo-subtle m-0">
                This calls a single `Predict` with a semantic image input. The
                client uploads a screenshot, the adapter converts it into AI SDK
                multimodal message content, and the model returns structured
                JSON.
              </p>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-kumo-subtle uppercase tracking-wide">
                  Question
                </span>
                <input
                  className="w-full rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
                  value={visionQuestion}
                  onChange={(event) => setVisionQuestion(event.target.value)}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-kumo-subtle uppercase tracking-wide">
                  Screenshot
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="block w-full text-sm text-kumo-default"
                  onChange={(event) =>
                    void onImageChange(event.target.files?.[0] ?? null)
                  }
                />
              </label>

              {imagePreview && (
                <img
                  src={imagePreview}
                  alt="Uploaded screenshot preview"
                  className="max-h-56 rounded-xl border border-kumo-line"
                />
              )}

              <div className="flex items-center gap-3">
                <Button
                  variant="primary"
                  size="sm"
                  loading={visionLoading}
                  onClick={runVisionWorkflow}
                >
                  Run screenshot module
                </Button>
                <Badge variant="secondary">image() input</Badge>
              </div>

              {visionResult ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  <JsonCard
                    title="Structured Result"
                    value={visionResult.result}
                  />
                  <div className="space-y-3">
                    <Text size="sm" bold>
                      Recent Trace Summary
                    </Text>
                    <TraceList traces={visionResult.traces} />
                  </div>
                </div>
              ) : (
                <Empty
                  icon={<ImageIcon size={30} />}
                  title="No screenshot result yet"
                  description="Upload an image and run the multimodal Predict example."
                />
              )}
            </Surface>
          </div>

          <div className="space-y-5">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <Text size="sm" bold>
                What This Example Shows
              </Text>
              <div className="space-y-3 text-sm text-kumo-subtle">
                <p className="m-0">
                  `signature(...).withInput(...).withOutput(...)` defines a
                  typed contract.
                </p>
                <p className="m-0">
                  `Predict` uses the default AI SDK adapter, so the example does
                  not configure one explicitly.
                </p>
                <p className="m-0">
                  `SupportWorkflowModule` demonstrates explicit child
                  registration via `this.child("classify", ...)`.
                </p>
                <p className="m-0">
                  Traces are persisted in SQLite through `SqliteModuleStore`,
                  and the UI surfaces recent ASI/meta counts after each run.
                </p>
              </div>
            </Surface>

            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-center gap-2">
                <ArrowsClockwiseIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Current Session
                </Text>
              </div>
              <div className="space-y-2 text-sm text-kumo-subtle">
                <div>Agent id: ModulesExampleAgent</div>
                <div>Session name: {sessionId}</div>
                <div>Connection: {status}</div>
              </div>
            </Surface>

            {error && (
              <Surface className="rounded-2xl ring ring-kumo-line p-4">
                <div className="flex items-start gap-3">
                  <WarningCircleIcon
                    size={18}
                    weight="bold"
                    className="text-kumo-danger mt-0.5"
                  />
                  <div>
                    <Text size="sm" bold>
                      Request failed
                    </Text>
                    <div className="mt-1 text-sm text-kumo-subtle">{error}</div>
                  </div>
                </div>
              </Surface>
            )}
          </div>
        </div>
      </main>

      <footer className="px-5 py-4 border-t border-kumo-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <Text size="xs" variant="secondary">
            Experimental surface built with `Think`, `Module`, `Predict`, and
            the default AI SDK adapter.
          </Text>
          <PoweredByCloudflare />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
