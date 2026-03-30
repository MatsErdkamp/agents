import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [path.join(import.meta.dirname, "src/tests/**/*.test.ts")],
    environment: "node"
  }
});
