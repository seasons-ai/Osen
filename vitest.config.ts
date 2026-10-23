import { defineConfig } from "vitest/config";

export default defineConfig({
  // design/ has no tsconfig: without this the shared OsenMark.tsx compiles to classic React.createElement
  esbuild: { jsx: "automatic" },
  test: {
    env: { COUNCIL_LANG: "ru" },
    // tests start real processes, and on macOS the first launch of every fresh stub is checked by the system
    // (writeExecutable warms it, which can take over 10 s under load); CI passes its own --testTimeout
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./vitest.setup.ts"],
  },
});
