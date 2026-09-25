import type { Plugin, UserConfig } from "vite";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "../vite.config";

export const E2E_PORT = 1430;

/** Installs the mocked Tauri IPC before the app entry module evaluates. */
function mockBackendBootPlugin(): Plugin {
  return {
    name: "tunara-e2e-mock-backend",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace(
        '<script type="module" src="/src/main.tsx"></script>',
        '<script type="module" src="/e2e/boot.ts"></script>\n    <script type="module" src="/src/main.tsx"></script>',
      ),
    },
  };
}

export default defineConfig(async (env) => {
  const resolved = typeof baseConfig === "function" ? await baseConfig(env) : await baseConfig;
  return mergeConfig(resolved as UserConfig, {
    plugins: [mockBackendBootPlugin()],
    build: { outDir: "dist-e2e", emptyOutDir: true },
    preview: { port: E2E_PORT, strictPort: true, host: "127.0.0.1" },
  });
});
