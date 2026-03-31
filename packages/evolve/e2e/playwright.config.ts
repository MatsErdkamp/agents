import { defineConfig } from "playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8802;
const e2eDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(e2eDir, "wrangler.jsonc");

export default defineConfig({
  testDir: e2eDir,
  testMatch: "*.spec.ts",
  timeout: 120_000,
  retries: 1,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`
  },
  webServer: {
    command: `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null; npx wrangler dev --config ${configPath} --port ${PORT} --inspector-port 0`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
