# @cloudflare/evolve

Optimization primitives for `@cloudflare/modules`.

The first cut is intentionally narrow:

- strategy interface for future optimizers
- `Evolve` orchestration helper
- `TraceReviewStrategy`, which inspects recent traces and proposes better
  instructions or signature guidance

It does not mutate modules. It returns suggestions that can be reviewed and
promoted later.
