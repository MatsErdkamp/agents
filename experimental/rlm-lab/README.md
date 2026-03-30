# RLM Lab

An experimental frontend for the shell-backed `RLM` in `@cloudflare/modules`.

It is built to validate the core RLM claim: the top-level model does not get
the full dossier in prompt context. Instead, the request is ingested into a
`Workspace`, exposed through `state.*`, and explored iteratively inside a
codemode sandbox.

## What it demonstrates

- shell-backed `RLM` execution via `createShellRLMRuntime`
- context ingestion into a workspace manifest instead of raw prompt stuffing
- iterative `act` / `extract` module traces
- persistent `scratch` state across steps
- semantic `query()` and `queryBatch()` powered by subagents
- recent trace summaries and root trace event inspection in the UI

## Running it

```bash
npm install
npm start
```

The experiment uses Workers AI via the `AI` binding and requires the
`worker_loaders` binding in `wrangler.jsonc` for codemode execution.

## Suggested flow

1. Load the sample dossier or paste a long report into the dossier textarea.
2. Ask a concrete question that requires evidence gathering.
3. Run the investigator and inspect the returned evidence, the trace rows, and
   the root event stream.
4. Change the question and rerun to see how the same workspace-backed context is
   explored differently.

## Related code

- [server.ts](./src/server.ts) for the parent agent, subagent query helper, and RLM module wiring
- [client.tsx](./src/client.tsx) for the experimental dossier UI
- [`packages/modules/src/rlm.ts`](../../packages/modules/src/rlm.ts) for the core shell-backed loop
