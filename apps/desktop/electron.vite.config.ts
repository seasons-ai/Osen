import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@model-council/core"] })],
    build: {
      rollupOptions: {
        // PDF text extraction runs in a child process: two self-contained files next to index.js
        input: {
          index: resolve("src/main/index.ts"),
          "pdf-extract": resolve("../../packages/core/src/pdf/pdf-extract.ts"),
          "pdf-worker": resolve("../../packages/core/src/pdf/pdf-worker.ts"),
          "html-worker": resolve("../../packages/core/src/url/html-worker.ts"),
        },
        output: { entryFileNames: (chunk) => (/^(pdf-|html-worker)/.test(chunk.name) ? "[name].mjs" : "[name].js") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@model-council/core"] })],
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
