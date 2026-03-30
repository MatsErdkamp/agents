import "./styles.css";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useCallback, useState } from "react";
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
  CheckCircleIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type {
  InvestigationResult,
  ModuleRunResponse,
  TraceSummary
} from "./server";

const SAMPLE_DOSSIER = `Document 1: Board memo, January 6
Northcoast Biologics is preparing to acquire Vantage Synapse for 480 million euros. The stated rationale is a faster oncology data platform rollout. The memo warns that the acquisition model only works if the Vantage sales pipeline remains above 135 million euros for the next two quarters and if the Lyon data-migration program lands before September.

Document 2: Finance note, January 11
Controller review flagged that 24.7 million euros of "pipeline" came from unsigned expansion scenarios, not executed contracts. The note says the commercial team treated three verbal renewals as committed revenue. Finance recommends haircutting forecasted pipeline by at least 18 million euros until the agreements are countersigned.

Document 3: Customer success escalation, January 14
The Lyon migration is delayed after two hospital groups refused the current consent-flow design. Product legal estimated a minimum six-week slip. The escalation notes that any delay past mid-August would push revenue recognition from the platform bundle into Q4.

Document 4: CEO email, January 18
The CEO wrote that the market story depends on maintaining the image of a clean acceleration play. She asked the deal team not to "re-litigate the synergy math in broad forums" until the diligence room is locked down. She did not instruct anyone to falsify data.

Document 5: Internal diligence transcript, January 21
An operating partner said the Lyon timeline was "best case, not base case." Another diligence member responded that the acquisition committee deck still used the best-case date because "anything else spooks the board before signatures." No one in the meeting documented a revised forecast.

Document 6: Sales VP message, January 23
The Sales VP said one of the three verbal renewals was effectively dead after procurement redirected budget. He estimated that the real committed expansion pipeline was closer to 9 million euros than 24.7 million euros.

Document 7: Risk committee minutes, January 26
The committee listed two material risks: overstated near-term pipeline and the Lyon migration dependency. It recommended either repricing the transaction or adding a holdback tied to implementation milestones. The recommendation was not reflected in the next board pack.

Document 8: Updated board pack, January 29
The deck still showed 24 million euros of expansion upside and kept the Lyon launch in late July. A footnote described the risks as "actively managed execution items" without quantifying downside. The pack concluded that deal timing pressure justified keeping the existing purchase price.

Document 9: Counsel summary, February 2
Outside counsel wrote that selective omission of known downside scenarios could create disclosure problems if directors relied on the board pack as a balanced view of diligence findings. Counsel advised preserving drafts and documenting a revised downside case immediately.

Document 10: Integration PM note, February 4
The PM wrote that the earliest realistic Lyon cutover was September 18 given engineering and consent-work backlog. She also noted that the July date in the board pack had not been revalidated after the hospital objections.

Document 11: CFO draft, February 5
The CFO prepared a side memo saying the current price assumes performance that management no longer considers probable. He recommended renegotiating by at least 40 million euros or pausing signing. The draft was never circulated to the full board.

Document 12: Committee chair text, February 6
The chair asked whether the team had "clean enough support" to defend the current valuation if challenged later. The response from diligence lead was: "Only if nobody asks for the downside version of the numbers."`;

const SAMPLE_QUESTION =
  "Based on the dossier, what is the strongest reason the board should have repriced or paused the acquisition?";

let sessionId = localStorage.getItem("rlm-lab-session");
if (!sessionId) {
  sessionId = crypto.randomUUID().slice(0, 8);
  localStorage.setItem("rlm-lab-session", sessionId);
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
        description="Run the RLM example to see durable trace summaries and ASI counts."
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
          {trace.latestAsiMessage ? (
            <div className="text-xs text-kumo-warning">
              Latest ASI: {trace.latestAsiMessage}
            </div>
          ) : null}
        </Surface>
      ))}
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [question, setQuestion] = useState(SAMPLE_QUESTION);
  const [dossier, setDossier] = useState(SAMPLE_DOSSIER);
  const [result, setResult] =
    useState<ModuleRunResponse<InvestigationResult> | null>(null);
  const [snapshot, setSnapshot] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent({
    agent: "RlmLabAgent",
    name: sessionId!,
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), [])
  });

  const runInvestigation = async () => {
    setLoading(true);
    setError(null);

    try {
      const next = (await agent.call("runInvestigation", [
        {
          question,
          dossier
        }
      ])) as ModuleRunResponse<InvestigationResult>;

      setResult(next);
      setSnapshot(next.traces);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const refreshSnapshot = async () => {
    setRefreshing(true);
    setError(null);

    try {
      const next = (await agent.call("getTraceSnapshot", [])) as {
        investigation: TraceSummary[];
      };
      setSnapshot(next.investigation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const traces = result?.traces ?? snapshot;

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <MagnifyingGlassIcon
                size={22}
                className="text-kumo-accent"
                weight="bold"
              />
              <h1 className="text-lg font-semibold text-kumo-default">
                Experimental RLM
              </h1>
              <Badge variant="secondary">@cloudflare/modules</Badge>
            </div>
            <p className="mt-1 text-sm text-kumo-subtle">
              A near-copy of the modules example, but the server path runs a
              shell-backed `RLM` over a large dossier instead of a plain
              `Predict`.
            </p>
          </div>
          <ConnectionIndicator status={status} />
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-6xl mx-auto grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-5">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-center gap-2">
                <MagnifyingGlassIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Dossier Investigation Module
                </Text>
              </div>
              <p className="text-sm text-kumo-subtle m-0">
                This runs a shell-backed `RLM`. The root model sees manifest
                metadata and trace history, explores the dossier with `state.*`,
                can call subagent-backed `query()` helpers, and then submits a
                structured answer.
              </p>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-kumo-subtle uppercase tracking-wide">
                  Question
                </span>
                <textarea
                  className="w-full min-h-24 rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-kumo-subtle uppercase tracking-wide">
                  Dossier
                </span>
                <textarea
                  className="w-full min-h-80 rounded-xl border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
                  value={dossier}
                  onChange={(event) => setDossier(event.target.value)}
                />
              </label>

              <div className="flex items-center gap-3">
                <Button
                  variant="primary"
                  size="sm"
                  loading={loading}
                  onClick={runInvestigation}
                >
                  Run RLM
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={refreshing}
                  onClick={refreshSnapshot}
                >
                  Refresh traces
                </Button>
                <Badge variant="secondary">
                  Shell runtime + subagent queries
                </Badge>
              </div>

              {result ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  <JsonCard title="Structured Result" value={result.result} />
                  <div className="space-y-3">
                    <Text size="sm" bold>
                      Recent Trace Summary
                    </Text>
                    <TraceList traces={result.traces} />
                  </div>
                </div>
              ) : (
                <Empty
                  icon={<CheckCircleIcon size={30} />}
                  title="No investigation result yet"
                  description="Run the dossier example to see the RLM output and recent trace rows."
                />
              )}
            </Surface>
          </div>

          <div className="space-y-5">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <Text size="sm" bold>
                What Changed From The Modules Example
              </Text>
              <div className="space-y-3 text-sm text-kumo-subtle">
                <p className="m-0">
                  The UI and trace-summary flow are intentionally similar to the
                  stock modules example.
                </p>
                <p className="m-0">
                  The server now uses `RLM` with `createShellRLMRuntime(...)`
                  and a `Workspace`, so the long dossier is explored through a
                  filesystem-backed context.
                </p>
                <p className="m-0">
                  `createSubAgentQueryProvider(...)` powers semantic sub-queries
                  without stuffing the whole dossier into the root prompt.
                </p>
                <p className="m-0">
                  Traces still persist through `SqliteModuleStore`, and this UI
                  only shows concise summary rows to keep the dev surface
                  simple.
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
                <div>Agent id: RlmLabAgent</div>
                <div>Session name: {sessionId}</div>
                <div>Connection: {status}</div>
              </div>
            </Surface>

            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <Text size="sm" bold>
                Trace Snapshot
              </Text>
              <TraceList traces={traces} />
            </Surface>

            {error ? (
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
            ) : null}
          </div>
        </div>
      </main>

      <footer className="px-5 py-4 border-t border-kumo-line">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <Text size="xs" variant="secondary">
            Experimental surface built by porting the modules example to a
            shell-backed `RLM`.
          </Text>
          <PoweredByCloudflare />
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
