# Experimental Modules

An experimental demo of the new `@cloudflare/modules` surface.

It shows:

- fluent signatures with `signature(...).withInput(...).withOutput(...)`
- a composed `Module` with explicit child registration
- direct `Predict` usage with multimodal `image()` input
- durable trace storage through `SqliteModuleStore`
- recent trace summaries surfaced back to the UI

## What this demonstrates

### 1. Composed modules

The support workflow is a root module that calls two child `Predict` nodes:

- `supportWorkflow.classify`
- `supportWorkflow.reply`

That keeps the user-facing API small while still producing trace rows for each
step.

```ts
class SupportWorkflowModule extends Module<
  typeof supportWorkflowSignature.input,
  typeof supportWorkflowSignature.output
> {
  classify = this.child("classify", new Predict(classifyTicketSignature));
  reply = this.child("reply", new Predict(draftReplySignature));
}
```

### 2. Multimodal input

The screenshot workflow uses `image()` in the signature and sends a semantic
image input value:

```ts
await agent.call("describeScreenshot", [
  {
    question: "What should I mention in the alt text?",
    screenshot: {
      type: "image",
      data: imageDataUrl,
      mediaType: "image/png"
    }
  }
]);
```

The default adapter converts that into AI SDK multimodal message content.

### 3. Trace-aware runtime

Each invocation writes module traces into SQLite. The example reads recent trace
rows and displays:

- module path
- status
- latency
- ASI event count
- metadata event count

## Running it

```bash
npm install
npm start
```

No external API keys are needed. The example uses Workers AI through the `AI`
binding in `wrangler.jsonc`.

## Suggested flow

1. Run the support workflow and inspect the nested `classification` and
   `resolution` output.
2. Upload a screenshot and run the multimodal `Predict`.
3. Compare the trace summaries to see how root module and child module paths are
   recorded separately.

## Related examples

- [`assistant`](../../examples/assistant) for a full conversational `Think` host
- [`structured-input`](../../examples/structured-input) for a smaller UI-oriented AI SDK example
