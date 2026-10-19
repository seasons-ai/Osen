import { defineConfig } from "vitest/config";

export default defineConfig({
  // design/ has no tsconfig: without this the shared OsenMark.tsx compiles to classic React.createElement
  esbuild: { jsx: "automatic" },
  test: {
    env: { COUNCIL_LANG: "ru" },
    // tests start real processes; the same ceiling as CI, so npm test does not fail under a busy machine
    testTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
  },
});
