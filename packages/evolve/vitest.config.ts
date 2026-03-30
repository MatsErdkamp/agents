import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/modules": path.join(
        import.meta.dirname,
        "../modules/src/index.ts"
      )
    }
  },
  test: {
    include: [path.join(import.meta.dirname, "src/tests/**/*.test.ts")],
    environment: "node"
  }
});
