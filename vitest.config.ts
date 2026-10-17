import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { COUNCIL_LANG: "ru" },
    setupFiles: ["./vitest.setup.ts"],
  },
});
