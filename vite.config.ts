import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import path from "path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

function shellTintBootPlugin(): Plugin {
  return {
    name: "shell-tint-boot",
    async transformIndexHtml(html) {
      const { renderBootInlineScript } = await import("./src/styles/shell-tint-boot.ts");
      const snippet = renderBootInlineScript();
      return html.replace("/*__SHELL_TINT_BOOT__*/", snippet);
    },
  };
}

/** Phosphor ships six weights per icon. Tunara only uses regular and bold. */
const PHOSPHOR_KEEP_WEIGHTS = new Set(["regular", "bold"]);

function trimPhosphorWeights(code: string): string | null {
  const markerMatch = code.match(/const \w+ = \/\* @__PURE__ \*\/ new Map\(\[/);
  if (!markerMatch || markerMatch.index === undefined) return null;
  const marker = markerMatch[0];
  const start = markerMatch.index;
  const end = code.lastIndexOf("]);");
  if (end < 0) return null;
  const body = code.slice(start + marker.length, end);
  const kept: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "[") continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < body.length; j++) {
      const ch = body[j];
      if (inStr) {
        if (ch === "\\") {
          j++;
          continue;
        }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          const entry = body.slice(i, j + 1);
          const weight = entry.match(/^\s*\[\s*"(\w+)"/)?.[1];
          if (weight && PHOSPHOR_KEEP_WEIGHTS.has(weight)) kept.push(entry.trim());
          i = j;
          break;
        }
      }
    }
  }
  if (kept.length === 0) return null;
  return `${code.slice(0, start)}${marker}\n  ${kept.join(",\n  ")}\n]);${code.slice(end + 3)}`;
}

const PHOSPHOR_TRIM_PREFIX = "\0phosphor-trim:";

function phosphorWeightTrimPlugin(): Plugin {
  return {
    name: "phosphor-weight-trim",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source.includes("defs/")) return;
      if (!importer.includes("phosphor-icons")) return;
      const importerPath = importer.split("?", 1)[0];
      const resolved = path.resolve(path.dirname(importerPath), source);
      return PHOSPHOR_TRIM_PREFIX + resolved;
    },
    load(id) {
      if (!id.startsWith(PHOSPHOR_TRIM_PREFIX)) return;
      const file = id.slice(PHOSPHOR_TRIM_PREFIX.length);
      const source = readFileSync(file, "utf8");
      return trimPhosphorWeights(source) ?? source;
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  base: "./",
  plugins: [phosphorWeightTrimPlugin(), react(), shellTintBootPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  esbuild: {
    drop: mode === "production" ? (["debugger"] as ["debugger"]) : [],
    pure:
      mode === "production"
        ? ["console.debug", "console.info", "console.trace"]
        : [],
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 1500,
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => {
          const name = dep.split("/").pop() ?? dep;
          return name.startsWith("react-") || name.startsWith("xterm-");
        });
      },
    },
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/xterm/") || id.includes("@xterm/")) return "xterm";
          if (id.includes("@phosphor-icons/")) return;
          if (
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/scheduler/")
          )
            return "react";
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
