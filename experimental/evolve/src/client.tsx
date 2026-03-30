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
  BugBeetleIcon,
  CheckCircleIcon,
  FlaskIcon,
  LightbulbIcon,
  MoonIcon,
  SparkleIcon,
  SunIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type {
  EvolveResponse,
  ModuleRunResponse,
  SupportWorkflowResult,
  TraceSummary
} from "./server";

let sessionId = localStorage.getItem("evolve-experimental-session");
if (!sessionId) {
  sessionId = crypto.randomUUID().slice(0, 8);
  localStorage.setItem("evolve-experimental-session", sessionId);
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
        description="Run the support workflow a few times before asking Evolve for a suggestion."
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

function SuggestionCard({
  suggestion,
  applied
}: {
  suggestion: EvolveResponse["suggestions"][number];
  applied?: EvolveResponse["applied"][number];
}) {
  return (
    <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text size="sm" bold>
            {suggestion.modulePath}
          </Text>
          <div className="mt-1 text-sm text-kumo-subtle">
            {suggestion.summary}
          </div>
        </div>
        <Badge variant="secondary">{suggestion.confidence}</Badge>
      </div>

      {suggestion.suggestedInstructions && (
        <div>
          <Text size="xs" bold>
            Suggested Instructions
          </Text>
          <pre className="mt-2 m-0 p-3 text-xs overflow-x-auto text-kumo-default bg-kumo-base font-mono rounded-xl border border-kumo-line whitespace-pre-wrap">
            {suggestion.suggestedInstructions}
          </pre>
        </div>
      )}

      {(Object.keys(suggestion.suggestedInputFieldDescriptions).length > 0 ||
        Object.keys(suggestion.suggestedOutputFieldDescriptions).length >
          0) && (
        <div className="space-y-3">
          {Object.keys(suggestion.suggestedInputFieldDescriptions).length >
            0 && (
            <JsonCard
              title="Suggested Input Field Descriptions"
              value={suggestion.suggestedInputFieldDescriptions}
            />
          )}
          {Object.keys(suggestion.suggestedOutputFieldDescriptions).length >
            0 && (
            <JsonCard
              title="Suggested Output Field Descriptions"
              value={suggestion.suggestedOutputFieldDescriptions}
            />
          )}
        </div>
      )}

      <div>
        <Text size="xs" bold>
          Rationale
        </Text>
        <ul className="mt-2 space-y-2 pl-5 text-sm text-kumo-subtle">
          {suggestion.rationale.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      </div>

      {suggestion.evidence.length > 0 && (
        <JsonCard title="Evidence" value={suggestion.evidence} />
      )}

      {applied && Object.keys(applied.appliedArtifacts).length > 0 && (
        <JsonCard title="Applied Artifacts" value={applied.appliedArtifacts} />
      )}
    </Surface>
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
  const [evolveResult, setEvolveResult] = useState<EvolveResponse | null>(null);
  const [supportLoading, setSupportLoading] = useState(false);
  const [evolveLoading, setEvolveLoading] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent({
    agent: "EvolveExampleAgent",
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

  const requestSuggestion = async () => {
    setEvolveLoading(true);
    setError(null);

    try {
      const result = (await agent.call(
        "suggestSupportImprovements",
        []
      )) as EvolveResponse;
      setEvolveResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEvolveLoading(false);
    }
  };

  const applySuggestion = async () => {
    setApplyLoading(true);
    setError(null);

    try {
      const result = (await agent.call(
        "applySupportImprovements",
        []
      )) as EvolveResponse;
      setEvolveResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplyLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <FlaskIcon size={22} className="text-kumo-accent" weight="bold" />
              <h1 className="text-lg font-semibold text-kumo-default">
                Experimental Evolve
              </h1>
              <Badge variant="secondary">@cloudflare/evolve</Badge>
            </div>
            <p className="mt-1 text-sm text-kumo-subtle">
              Run a module, accumulate traces, and ask the barebones
              trace-review strategy for instruction and field-description
              improvements.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionIndicator status={status} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-6xl mx-auto grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-5">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-center gap-2">
                <SparkleIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Generate Traces
                </Text>
              </div>
              <p className="text-sm text-kumo-subtle m-0">
                This uses the same support workflow module as the modules demo.
                Run it a few times with different queries so Evolve has real
                trace evidence to review.
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
                  Run support workflow
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={evolveLoading}
                  onClick={requestSuggestion}
                >
                  Ask evolve for suggestion
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={applyLoading}
                  onClick={applySuggestion}
                >
                  Apply evolve suggestion
                </Button>
              </div>

              {supportResult ? (
                <JsonCard
                  title="Latest Structured Result"
                  value={supportResult.result}
                />
              ) : (
                <Empty
                  icon={<CheckCircleIcon size={30} />}
                  title="No workflow result yet"
                  description="Run the support workflow first so the trace-review strategy has something to inspect."
                />
              )}
            </Surface>

            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-center gap-2">
                <BugBeetleIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Recent Trace Summary
                </Text>
              </div>
              <TraceList
                traces={evolveResult?.traces ?? supportResult?.traces ?? []}
              />
            </Surface>
          </div>

          <div className="space-y-5">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-center gap-2">
                <LightbulbIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Optimizer Output
                </Text>
              </div>
              <p className="text-sm text-kumo-subtle m-0">
                The current `TraceReviewStrategy` is intentionally simple: it
                reads traces, packages the current instructions plus field
                descriptions, and asks a model for proposed instruction and
                description updates.
              </p>

              {evolveResult ? (
                <div className="space-y-4">
                  <JsonCard
                    title="Current Active Config"
                    value={evolveResult.currentConfig}
                  />
                  {evolveResult.suggestions.map((suggestion, index) => (
                    <SuggestionCard
                      key={`${suggestion.modulePath}-${index}`}
                      suggestion={suggestion}
                      applied={evolveResult.applied[index]}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<LightbulbIcon size={30} />}
                  title="No suggestion yet"
                  description="Click “Ask evolve for suggestion” after running the workflow a few times."
                />
              )}
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
            Experimental optimization loop built on `@cloudflare/modules` and
            `@cloudflare/evolve`.
          </Text>
          <PoweredByCloudflare />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
