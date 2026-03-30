# Experimental Evolve

An experimental demo of the new `@cloudflare/evolve` surface.

It shows the smallest useful optimization loop:

1. run a composed module
2. persist traces and ASI
3. ask `Evolve` for a suggestion based on recent traces

## What this demonstrates

### 1. Trace-driven review

The demo uses a `SupportWorkflowModule` built from two child `Predict` nodes.
Each invocation writes module traces into SQLite using `SqliteModuleStore`.

### 2. Barebones optimization strategy

The first `Evolve` strategy is intentionally narrow:

- load recent traces and trace events
- serialize current instructions and schemas
- ask a model for:
  - suggested instructions
  - signature guidance
  - rationale
  - evidence
  - confidence

It does not mutate the module. It only returns suggestions.

### 3. A clean package split

The example uses:

- `@cloudflare/modules` for execution
- `@cloudflare/evolve` for optimization
- `@cloudflare/think` only as the host runtime

## Running it

```bash
npm install
npm start
```

No external API keys are needed. The example uses Workers AI through the `AI`
binding in `wrangler.jsonc`.

## Suggested flow

1. Run the support workflow with a few different inputs.
2. Open the trace panel and confirm traces/ASI are being written.
3. Click “Ask evolve for suggestion”.
4. Inspect the returned instruction change proposal and evidence.

## Related examples

- [`modules`](../modules) for the lower-level module runtime demo
- [`assistant`](../../examples/assistant) for a full conversational `Think` host
