# @cloudflare/modules

Typed LM modules for Cloudflare Agents.

This package contains:

- fluent signatures via `signature(...).withInput(...).withOutput(...)`
- `Predict` for structured LLM calls
- `Module` for composition and child registration
- multimodal input helpers like `image()`
- SQLite-friendly trace storage through `SqliteModuleStore`
