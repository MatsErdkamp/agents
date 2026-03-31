import "./styles.css";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { startTransition, useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Empty,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  BezierCurveIcon,
  ChartLineUpIcon,
  FloppyDiskBackIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SparkleIcon,
  SunIcon,
  TrashIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import type {
  CandidateView,
  OptimizationDashboard,
  TextSurfaceView,
  TraceExampleView
} from "./server";

let sessionId = localStorage.getItem("evolve-rlm-session");
if (!sessionId) {
  sessionId = crypto.randomUUID().slice(0, 8);
  localStorage.setItem("evolve-rlm-session", sessionId);
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const dot =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <div className="flex items-center gap-2" role="status">
      <span className={`size-2 rounded-full ${dot}`} />
      <span className="text-xs text-kumo-subtle">
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
      <div className="text-3xl font-semibold text-kumo-default">{value}</div>
      <div className="text-xs text-kumo-subtle">{hint}</div>
    </Surface>
  );
}

function TextSurfaceCard({ surface }: { surface: TextSurfaceView }) {
  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text size="sm" bold>
            {surface.label}
          </Text>
          <div className="mt-1 text-xs text-kumo-subtle">
            {surface.modulePath} · {surface.artifactType}
            {surface.fieldName ? ` · ${surface.fieldName}` : ""}
          </div>
        </div>
        {surface.artifactId ? (
          <Badge variant="secondary">active artifact</Badge>
        ) : null}
      </div>

      <pre className="m-0 p-4 text-xs overflow-x-auto text-kumo-default bg-kumo-base font-mono rounded-xl border border-kumo-line whitespace-pre-wrap">
        {surface.text || "(empty)"}
      </pre>
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
          <div className="mt-1 text-xs text-kumo-subtle">
            {example.question}
          </div>
        </div>
        <Badge
          variant={
            example.score != null && example.score >= 0.85
              ? "success"
              : "secondary"
          }
        >
          {example.score == null
            ? "unseen"
            : `score ${formatScore(example.score)}`}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="p-3 rounded-xl border border-kumo-line bg-kumo-base">
          <div className="text-xs text-kumo-subtle">expected</div>
          <div className="mt-1 text-sm font-bold text-kumo-default">
            {example.expectedSnippets.join(" / ")}
          </div>
        </div>
        <div className="p-3 rounded-xl border border-kumo-line bg-kumo-base">
          <div className="text-xs text-kumo-subtle">answer</div>
          <div className="mt-1 text-sm font-bold text-kumo-default">
            {example.answer ?? "—"}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">
          confidence {example.confidence ?? "—"}
        </Badge>
        <Badge variant="secondary">evidence {example.evidenceCount}</Badge>
        <Badge variant="secondary">{example.status}</Badge>
      </div>

      {example.approach ? (
        <div className="text-sm text-kumo-subtle">{example.approach}</div>
      ) : null}

      {example.asi.length > 0 ? (
        <div className="space-y-2">
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

function CandidateCard({ candidate }: { candidate: CandidateView }) {
  return (
    <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Text size="sm" bold>
            {candidate.componentLabel}
          </Text>
          <div className="mt-1 text-xs text-kumo-subtle">
            {candidate.source} · gen {candidate.generation}
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

      <div className="text-xs text-kumo-subtle">{candidate.summary}</div>

      <div className="grid gap-3 sm:grid-cols-2">
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
        {candidate.targetText ?? "(no text)"}
      </pre>
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
    agent: "EvolveRlmAgent",
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
              <Badge variant="secondary">RLM</Badge>
            </div>
            <h1 className="mt-4 text-4xl font-bold tracking-tight text-kumo-default">
              GEPA RLM Workbench
            </h1>
            <p className="mt-2 text-sm text-kumo-subtle leading-relaxed">
              Seed a shell-backed dossier benchmark, inspect ASI and feedback,
              then run GEPA over the RLM text surfaces that control `act` and
              `extract`.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <ConnectionIndicator status={status} />
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard
              label="Fixtures"
              value={String(dashboard?.benchmark.length ?? 0)}
              hint="Shared dossier questions used for seeding and replay."
            />
            <StatCard
              label="Traces"
              value={String(dashboard?.traceCount ?? 0)}
              hint="Root and child RLM traces persisted in SQLite."
            />
            <StatCard
              label="Feedback"
              value={String(dashboard?.feedbackCount ?? 0)}
              hint="Stored scalar feedback used for replay scoring."
            />
            <StatCard
              label="Texts"
              value={String(dashboard?.currentTexts.length ?? 0)}
              hint={`${dashboard?.dossierLength ?? 0} dossier chars loaded into the workspace.`}
            />
          </div>

          <Surface className="rounded-2xl ring ring-kumo-line p-5">
            <div className="flex flex-wrap gap-3">
              <Button
                icon={<ArrowClockwiseIcon size={16} />}
                disabled={loading != null}
                onClick={() => void loadDashboard("refresh")}
              >
                Refresh
              </Button>
              <Button
                icon={<FloppyDiskBackIcon size={16} />}
                disabled={loading != null}
                onClick={() => void callAction("seedBenchmark", "seed")}
              >
                {loading === "seed" ? "Seeding..." : "Seed Benchmark"}
              </Button>
              <Button
                icon={<LightningIcon size={16} />}
                disabled={loading != null}
                onClick={() => void callAction("optimizeBenchmark", "optimize")}
              >
                {loading === "optimize" ? "Running GEPA..." : "Run GEPA"}
              </Button>
              <Button
                variant="ghost"
                icon={<TrashIcon size={16} />}
                disabled={loading != null}
                onClick={() => void callAction("resetExperiment", "reset")}
              >
                Reset
              </Button>
            </div>

            {error ? (
              <div className="mt-4 flex items-start gap-3 rounded-xl border border-kumo-danger/20 bg-kumo-danger/5 p-4 text-sm text-kumo-danger">
                <WarningCircleIcon size={18} className="mt-0.5 shrink-0" />
                <div>{error}</div>
              </div>
            ) : null}
          </Surface>

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <MagnifyingGlassIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Benchmark Questions
                </Text>
              </div>
              <div className="grid gap-4">
                {(dashboard?.benchmark ?? []).map((fixture) => (
                  <Surface
                    key={fixture.id}
                    className="rounded-xl ring ring-kumo-line p-4 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{fixture.focus}</Badge>
                      <Text size="sm" bold>
                        {fixture.id}
                      </Text>
                    </div>
                    <div className="text-sm text-kumo-default">
                      {fixture.question}
                    </div>
                    <div className="text-xs text-kumo-subtle">
                      Expected snippets: {fixture.expectedSnippets.join(" / ")}
                    </div>
                  </Surface>
                ))}
              </div>

              <div className="flex items-center gap-2 pt-2">
                <SparkleIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Latest Examples
                </Text>
              </div>
              <div className="grid gap-4">
                {(dashboard?.latestExamples ?? []).map((example) => (
                  <ExampleCard key={example.fixtureId} example={example} />
                ))}
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <ChartLineUpIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Active Text Surfaces
                </Text>
              </div>
              <div className="grid gap-4">
                {(dashboard?.currentTexts ?? []).map((surface) => (
                  <TextSurfaceCard
                    key={surface.componentId}
                    surface={surface}
                  />
                ))}
              </div>
            </section>
          </div>

          <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <ActivityIconFallback />
                <Text size="sm" bold>
                  Latest Run
                </Text>
              </div>

              {dashboard?.latestRun ? (
                <Surface className="rounded-2xl ring ring-kumo-line p-5 space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      seed {formatScore(dashboard.latestRun.seedScore)}
                    </Badge>
                    <Badge variant="secondary">
                      best {formatScore(dashboard.latestRun.bestScore)}
                    </Badge>
                    <Badge variant="secondary">
                      candidates {dashboard.latestRun.candidateCount}
                    </Badge>
                    <Badge variant="secondary">
                      artifacts {dashboard.latestRun.appliedArtifacts.length}
                    </Badge>
                  </div>
                  <div className="text-xs text-kumo-subtle">
                    Started{" "}
                    {new Date(dashboard.latestRun.startedAt).toLocaleString()}
                  </div>
                  <div className="space-y-2">
                    {dashboard.latestRun.appliedArtifacts.map((artifact) => (
                      <div
                        key={`${artifact.modulePath}:${artifact.artifactType}`}
                        className="text-sm text-kumo-subtle"
                      >
                        {artifact.modulePath} · {artifact.artifactType}
                      </div>
                    ))}
                  </div>
                </Surface>
              ) : (
                <Empty
                  icon={<SparkleIcon size={28} />}
                  title="No optimization run yet"
                  description="Seed the dossier benchmark and run GEPA to populate the archive and candidate pool."
                />
              )}
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <SparkleIcon
                  size={18}
                  weight="bold"
                  className="text-kumo-accent"
                />
                <Text size="sm" bold>
                  Candidate Pool
                </Text>
              </div>
              <div className="grid gap-4">
                {(dashboard?.latestRun?.candidates ?? []).map((candidate) => (
                  <CandidateCard
                    key={candidate.candidateId}
                    candidate={candidate}
                  />
                ))}
              </div>
            </section>
          </div>
        </div>
      </main>

      <footer className="border-t border-kumo-line px-5 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs text-kumo-subtle">
            RLM-specific GEPA experiment over shell-backed dossier traces.
          </div>
          <PoweredByCloudflare />
        </div>
      </footer>
    </div>
  );
}

function ActivityIconFallback() {
  return (
    <ChartLineUpIcon size={18} weight="bold" className="text-kumo-accent" />
  );
}

function formatScore(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }

  return value.toFixed(2);
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<App />);
}
