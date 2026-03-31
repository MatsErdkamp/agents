import "./styles.css";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { startTransition, useEffect, useState, useCallback } from "react";
import {
  Badge,
  Button,
  Empty,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ActivityIcon,
  ArrowClockwiseIcon,
  BezierCurveIcon,
  ChartLineUpIcon,
  FloppyDiskBackIcon,
  FlaskIcon,
  LightningIcon,
  SparkleIcon,
  TrashIcon,
  MoonIcon,
  SunIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type {
  CandidateView,
  OptimizationDashboard,
  TraceExampleView
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

function StatCard({
  label,
  value,
  hint
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
      <div className="text-xs uppercase tracking-[0.22em] text-kumo-subtle">
        {label}
      </div>
      <div className="mt-3 text-3xl font-semibold text-kumo-default">
        {value}
      </div>
      <div className="mt-2 text-xs text-kumo-subtle">{hint}</div>
    </Surface>
  );
}

function CandidateCard({ candidate }: { candidate: CandidateView }) {
  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text size="sm" bold>
            {candidate.source} · gen {candidate.generation}
          </Text>
          <div className="mt-1 text-xs text-kumo-subtle">
            {candidate.summary}
          </div>
        </div>
        <div className="flex gap-2">
          <Badge variant={candidate.accepted ? "success" : "secondary"}>
            {candidate.accepted ? "accepted" : "rejected"}
          </Badge>
          {candidate.promoted ? (
            <Badge variant="secondary">frontier</Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-1 p-3 rounded-xl border border-kumo-line bg-kumo-base">
          <span className="text-xs text-kumo-subtle">minibatch</span>
          <strong className="text-sm font-bold text-kumo-default">
            {formatScore(candidate.minibatchScore)}
          </strong>
        </div>
        <div className="flex items-baseline justify-between gap-1 p-3 rounded-xl border border-kumo-line bg-kumo-base">
          <span className="text-xs text-kumo-subtle">validation</span>
          <strong className="text-sm font-bold text-kumo-default">
            {formatScore(candidate.validationScore)}
          </strong>
        </div>
      </div>

      <pre className="m-0 p-4 text-xs overflow-x-auto text-kumo-default bg-kumo-base font-mono rounded-xl border border-kumo-line whitespace-pre-wrap">
        {candidate.instructions ?? "(no instructions)"}
      </pre>

      {candidate.rationale.length > 0 ? (
        <div className="mt-4 space-y-2">
          {candidate.rationale.map((reason, index) => (
            <div
              key={index}
              className="p-3 rounded-xl border-l-4 border-kumo-accent bg-kumo-base text-sm text-kumo-subtle"
            >
              {reason}
            </div>
          ))}
        </div>
      ) : null}
    </Surface>
  );
}

function ExampleCard({ example }: { example: TraceExampleView }) {
  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text size="sm" bold>
            {example.fixtureId}
          </Text>
          <div className="mt-1 text-xs text-kumo-subtle">{example.problem}</div>
        </div>
        <Badge variant={example.score === 1 ? "success" : "secondary"}>
          {example.score == null ? "unseen" : `score ${example.score}`}
        </Badge>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-1 p-3 rounded-xl border border-kumo-line bg-kumo-base">
          <span className="text-xs text-kumo-subtle">expected</span>
          <strong className="text-sm font-bold text-kumo-default">
            {example.expectedAnswer}
          </strong>
        </div>
        <div className="flex items-baseline justify-between gap-1 p-3 rounded-xl border border-kumo-line bg-kumo-base">
          <span className="text-xs text-kumo-subtle">actual</span>
          <strong className="text-sm font-bold text-kumo-default">
            {example.actualAnswer ?? "—"}
          </strong>
        </div>
      </div>

      {example.asi.length > 0 ? (
        <div className="mt-4 space-y-2">
          {example.asi.map((message, index) => (
            <div
              key={index}
              className="p-3 rounded-xl border-l-4 border-kumo-accent bg-kumo-base text-sm text-kumo-subtle"
            >
              {message}
            </div>
          ))}
        </div>
      ) : null}
    </Surface>
  );
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [dashboard, setDashboard] = useState<OptimizationDashboard | null>(
    null
  );
  const [loading, setLoading] = useState<
    "refresh" | "seed" | "optimize" | "reset" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent({
    agent: "EvolveExampleAgent",
    name: sessionId!,
    onOpen: useCallback(() => setStatus("connected"), []),
    onClose: useCallback(() => setStatus("disconnected"), [])
  });

  const loadDashboard = async (mode: typeof loading = "refresh") => {
    setLoading(mode);
    setError(null);

    try {
      const next = (await agent.call(
        "getDashboard",
        []
      )) as OptimizationDashboard;
      startTransition(() => setDashboard(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  };

  useEffect(() => {
    void loadDashboard();
  }, []);

  const callAction = async (
    method: "seedBenchmark" | "optimizeBenchmark" | "resetExperiment",
    mode: NonNullable<typeof loading>
  ) => {
    setLoading(mode);
    setError(null);

    try {
      const next = (await agent.call(method, [])) as OptimizationDashboard;
      startTransition(() => setDashboard(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-kumo-base">
      <header className="px-5 py-4 border-b border-kumo-line">
        <div className="max-w-7xl mx-auto flex items-start justify-between gap-6">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-full flex items-center justify-center bg-kumo-accent text-white shadow-lg">
                <BezierCurveIcon size={20} weight="bold" />
              </div>
              <Badge variant="secondary">@cloudflare/evolve</Badge>
            </div>
            <h1 className="mt-4 text-4xl font-bold tracking-tight text-kumo-default">
              GEPA Workbench
            </h1>
            <p className="mt-2 text-sm text-kumo-subtle leading-relaxed">
              Seed a benchmark with deliberately bad instructions, inspect ASI
              and feedback, then run the real GEPA optimizer and watch the
              candidate pool converge toward an activated winner.
            </p>
          </div>

          <div className="flex flex-col items-end gap-3">
            <div className="flex items-center gap-3">
              <ConnectionIndicator status={status} />
              <ModeToggle />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowClockwiseIcon size={16} />}
                onClick={() => void loadDashboard("refresh")}
                disabled={loading != null}
              >
                Refresh
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<FloppyDiskBackIcon size={16} />}
                onClick={() => void callAction("seedBenchmark", "seed")}
                disabled={loading != null}
              >
                {loading === "seed" ? "Seeding…" : "Seed Benchmark"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<LightningIcon size={16} />}
                onClick={() => void callAction("optimizeBenchmark", "optimize")}
                disabled={loading != null}
              >
                {loading === "optimize" ? "Optimizing…" : "Run GEPA"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<TrashIcon size={16} />}
                onClick={() => void callAction("resetExperiment", "reset")}
                disabled={loading != null}
              >
                Reset
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-7xl mx-auto space-y-6">
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
                    Worker error
                  </Text>
                  <div className="mt-1 text-sm text-kumo-subtle">{error}</div>
                </div>
              </div>
            </Surface>
          )}

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Traces"
              value={String(dashboard?.traceCount ?? 0)}
              hint="Benchmark executions persisted into the module store."
            />
            <StatCard
              label="Feedback"
              value={String(dashboard?.feedbackCount ?? 0)}
              hint="Exact-answer scores and comments available to reflection."
            />
            <StatCard
              label="Best Score"
              value={formatScore(dashboard?.latestRun?.bestScore ?? null)}
              hint="Latest validated GEPA winner."
            />
            <StatCard
              label="Candidates"
              value={String(dashboard?.latestRun?.candidateCount ?? 0)}
              hint="Generated across mutation and merge steps."
            />
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Text size="sm" bold>
                    Active Instructions
                  </Text>
                  <div className="mt-1 text-sm text-kumo-subtle">
                    This is the instruction set currently active for live
                    replay.
                  </div>
                </div>
                {dashboard?.activeArtifactId ? (
                  <Badge variant="secondary">artifact active</Badge>
                ) : (
                  <Badge variant="secondary">base signature</Badge>
                )}
              </div>
              <pre className="m-0 p-4 text-xs overflow-x-auto text-kumo-default bg-kumo-base font-mono rounded-xl border border-kumo-line whitespace-pre-wrap mt-4">
                {dashboard?.currentInstructions ?? "(loading instructions)"}
              </pre>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {dashboard?.benchmark.map((fixture) => (
                  <div
                    key={fixture.id}
                    className="p-4 rounded-xl border border-kumo-line bg-kumo-base"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <Text size="xs" bold>
                        {fixture.id}
                      </Text>
                      <Badge variant="secondary">{fixture.focus}</Badge>
                    </div>
                    <div className="mt-3 text-sm text-kumo-default">
                      {fixture.problem}
                    </div>
                    <div className="mt-3 text-xs text-kumo-subtle">
                      expected answer: <strong>{fixture.expectedAnswer}</strong>
                    </div>
                  </div>
                ))}
              </div>
            </Surface>

            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Text size="sm" bold>
                    Latest Optimization
                  </Text>
                  <div className="mt-1 text-sm text-kumo-subtle">
                    Seed score, validated winner, and frontier archive from the
                    most recent run.
                  </div>
                </div>
                <SparkleIcon
                  size={18}
                  className="text-kumo-accent"
                  weight="fill"
                />
              </div>

              {dashboard?.latestRun ? (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex items-baseline justify-between gap-1 p-3 rounded-xl border border-kumo-line bg-kumo-base">
                      <span className="text-xs text-kumo-subtle">seed</span>
                      <strong className="text-sm font-bold text-kumo-default">
                        {formatScore(dashboard.latestRun.seedScore)}
                      </strong>
                    </div>
                    <div className="flex items-baseline justify-between gap-1 p-3 rounded-xl border border-kumo-line bg-kumo-base">
                      <span className="text-xs text-kumo-subtle">best</span>
                      <strong className="text-sm font-bold text-kumo-default">
                        {formatScore(dashboard.latestRun.bestScore)}
                      </strong>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 text-xs text-kumo-subtle">
                    <div className="flex items-center justify-between p-2 rounded-lg bg-kumo-base border border-kumo-line">
                      <span>run id</span>
                      <strong className="text-kumo-default">
                        {dashboard.latestRun.runId.slice(0, 8)}
                      </strong>
                    </div>
                    <div className="flex items-center justify-between p-2 rounded-lg bg-kumo-base border border-kumo-line">
                      <span>started</span>
                      <strong className="text-kumo-default">
                        {new Date(
                          dashboard.latestRun.startedAt
                        ).toLocaleTimeString()}
                      </strong>
                    </div>
                    <div className="flex items-center justify-between p-2 rounded-lg bg-kumo-base border border-kumo-line">
                      <span>artifact</span>
                      <strong className="text-kumo-default">
                        {dashboard.latestRun.appliedArtifactId
                          ? "activated"
                          : "not applied"}
                      </strong>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {dashboard.latestRun.archive.map((entry) => (
                      <div
                        key={entry.candidateId}
                        className="p-2 rounded-lg bg-kumo-base border-l-4 border-kumo-accent text-xs text-kumo-subtle"
                      >
                        rank {entry.rank} · {entry.candidateId.slice(0, 8)} ·
                        validation {formatScore(entry.validationScore)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <Empty
                  icon={<FlaskIcon size={28} />}
                  title="No optimization run yet"
                  description="Seed the benchmark, then run GEPA to populate the candidate archive."
                />
              )}
            </Surface>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Text size="sm" bold>
                    Latest Trace Examples
                  </Text>
                  <div className="mt-1 text-sm text-kumo-subtle">
                    Each card pairs the latest trace bundle with ASI and
                    feedback.
                  </div>
                </div>
                <ActivityIcon
                  size={18}
                  className="text-kumo-accent"
                  weight="duotone"
                />
              </div>
              <div className="mt-4 grid gap-4">
                {dashboard?.latestExamples.length ? (
                  dashboard.latestExamples.map((example) => (
                    <ExampleCard key={example.fixtureId} example={example} />
                  ))
                ) : (
                  <Empty
                    icon={<ChartLineUpIcon size={28} />}
                    title="No benchmark traces yet"
                    description="The seed action executes the current instructions across all fixtures and stores ASI plus feedback."
                  />
                )}
              </div>
            </Surface>

            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Text size="sm" bold>
                    Candidate Pool
                  </Text>
                  <div className="mt-1 text-sm text-kumo-subtle">
                    Accepted and rejected candidates from the latest GEPA run.
                  </div>
                </div>
                <ChartLineUpIcon
                  size={18}
                  className="text-kumo-accent"
                  weight="duotone"
                />
              </div>

              {dashboard?.latestRun?.candidates.length ? (
                <div className="mt-4 grid gap-4">
                  {dashboard.latestRun.candidates.map((candidate) => (
                    <CandidateCard
                      key={candidate.candidateId}
                      candidate={candidate}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<SparkleIcon size={28} />}
                  title="No candidate history yet"
                  description="Run GEPA once to inspect the minibatch and validation trajectory."
                />
              )}
            </Surface>
          </section>

          <section className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Text size="sm" bold>
                    Recent Run Log
                  </Text>
                  <div className="mt-1 text-sm text-kumo-subtle">
                    Stored in the evolve SQLite tables for this agent instance.
                  </div>
                </div>
              </div>

              {dashboard?.recentRuns.length ? (
                <div className="mt-4 space-y-3">
                  {dashboard.recentRuns.map((run) => (
                    <div
                      key={run.runId}
                      className="flex items-center justify-between p-3 rounded-xl border border-kumo-line bg-kumo-base"
                    >
                      <div>
                        <div className="font-medium text-kumo-default">
                          {run.runId.slice(0, 8)}
                        </div>
                        <div className="mt-1 text-xs text-kumo-subtle">
                          {new Date(run.startedAt).toLocaleTimeString()}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-kumo-default">
                          {formatScore(run.bestValidationScore)}
                        </div>
                        <div className="mt-1 text-xs text-kumo-subtle">
                          {run.status}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<ArrowClockwiseIcon size={28} />}
                  title="No run history"
                  description="Optimization runs are persisted after the first GEPA execution."
                />
              )}
            </Surface>

            <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Text size="sm" bold>
                    How To Use It
                  </Text>
                  <div className="mt-1 text-sm text-kumo-subtle">
                    The UI is intentionally opinionated so the optimization loop
                    is easy to inspect.
                  </div>
                </div>
              </div>
              <div className="mt-4 grid gap-3">
                <div className="p-3 rounded-xl border-l-4 border-kumo-accent bg-kumo-base text-sm text-kumo-subtle">
                  1. <strong>Seed Benchmark</strong> runs the current
                  instructions across the local fixture set and records ASI +
                  feedback.
                </div>
                <div className="p-3 rounded-xl border-l-4 border-kumo-accent bg-kumo-base text-sm text-kumo-subtle">
                  2. <strong>Run GEPA</strong> replays those stored examples,
                  mutates the instructions, validates the winner, and activates
                  it if it beats the seed.
                </div>
                <div className="p-3 rounded-xl border-l-4 border-kumo-accent bg-kumo-base text-sm text-kumo-subtle">
                  3. <strong>Refresh</strong> reloads traces, recent runs,
                  active instructions, and the latest persisted optimization
                  snapshot.
                </div>
                <div className="p-3 rounded-xl border-l-4 border-kumo-accent bg-kumo-base text-sm text-kumo-subtle">
                  4. <strong>Reset</strong> clears module traces, feedback,
                  artifacts, and evolve runs for the current agent instance.
                </div>
              </div>
            </Surface>
          </section>
        </div>
      </main>

      <footer className="px-5 py-6 border-t border-kumo-line flex justify-center">
        <PoweredByCloudflare />
      </footer>
    </div>
  );
}

function formatScore(value: number | null): string {
  if (value == null) {
    return "—";
  }

  return value.toFixed(2);
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(<App />);
