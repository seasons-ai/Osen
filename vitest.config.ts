import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { COUNCIL_LANG: "ru" },
    // tests start real processes; the same ceiling as CI, so npm test does not fail under a busy machine
    testTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
  },
});
