import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

/** Monorepo root (`agents/`), two levels above this package */
const workspaceRoot = path.join(import.meta.dirname, "../..");

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  resolve: {
    // `useAgent` → partysocket/react and the app must share one React instance,
    // or hooks see a null dispatcher (invalid hook call). The Cloudflare plugin’s
    // multi-environment graphs make duplicate resolution more likely.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
    alias: {
      react: path.join(workspaceRoot, "node_modules/react"),
      "react-dom": path.join(workspaceRoot, "node_modules/react-dom"),
      "@cloudflare/think": path.join(
        import.meta.dirname,
        "../../packages/think/src/think.ts"
      ),
      "@cloudflare/modules": path.join(
        import.meta.dirname,
        "../../packages/modules/src/index.ts"
      )
    }
  },
  define: {
    __filename: "'index.ts'"
  }
});
