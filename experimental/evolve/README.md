# Experimental Evolve

An experimental GEPA workbench for `@cloudflare/evolve`.

It turns the new optimizer into a concrete UI:

1. seed a local benchmark with intentionally bad instructions
2. inspect persisted traces, ASI, and feedback
3. run GEPA over those stored examples
4. inspect candidate lineage, archive rank, and the activated winner

## What It Demonstrates

- `@cloudflare/modules` trace persistence and artifact activation
- `@cloudflare/evolve` replay-based optimization with `ModuleTraceAdapter`
- `SqliteEvolveStore` run history inside an Agents SDK durable object
- a frontend that makes the optimizer state inspectable instead of hiding it in logs

## Running It

```bash
npm install
npm start
```

No external API keys are required. The experiment uses Workers AI through the
`AI` binding in [`wrangler.jsonc`](./wrangler.jsonc).

## Suggested Flow

1. Click `Seed Benchmark` to persist a bad baseline run across the fixture set.
2. Inspect the latest example cards to confirm ASI and feedback are present.
3. Click `Run GEPA` and wait for the optimizer to finish.
4. Compare seed vs best score, browse the candidate pool, and confirm the winner
   was activated into the module artifacts.

## Related Code

- [`src/server.ts`](./src/server.ts) for the benchmark module, GEPA run loop, and persisted dashboard state
- [`src/client.tsx`](./src/client.tsx) for the optimization UI
- [`../../packages/evolve/src/index.ts`](../../packages/evolve/src/index.ts) for the optimizer implementation
- [`../../packages/modules/src/module.ts`](../../packages/modules/src/module.ts) for replay overlays and trace-returning invocation
