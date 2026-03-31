# Experimental Evolve RLM

An experimental GEPA workbench for shell-backed `RLM` modules.

It mirrors the math-oriented `experimental/evolve` app, but the benchmark is a
shared dossier and the optimized program is an `RLM` with `act` and `extract`
child prompts.

## What It Demonstrates

- shell-backed `RLM` execution through `@cloudflare/modules`
- persisted root-task traces, ASI, and scalar feedback for a dossier benchmark
- `@cloudflare/evolve` running GEPA over the RLM module graph
- a frontend for inspecting active text surfaces, replay examples, and accepted candidates

## Running It

```bash
npm install
npm start -w @cloudflare/agents-evolve-rlm-experimental
```

The experiment requires the `AI`, `worker_loaders`, and `RLM_ARTIFACTS`
bindings configured in [`wrangler.jsonc`](./wrangler.jsonc).

## Suggested Flow

1. Click `Seed Benchmark` to run the RLM over the embedded dossier questions.
2. Inspect the active text surfaces and latest example cards.
3. Click `Run GEPA` to evolve the RLM text parameters.
4. Compare the candidate pool and the activated artifacts from the latest run.

## Related Code

- [`src/server.ts`](./src/server.ts) for the RLM module, benchmark seeding, and GEPA loop
- [`src/client.tsx`](./src/client.tsx) for the optimization dashboard
- [`src/benchmark.ts`](./src/benchmark.ts) for the embedded dossier benchmark
