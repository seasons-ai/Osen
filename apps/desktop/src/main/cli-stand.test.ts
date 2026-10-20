import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standCandidateDeps } from "./cli-stand.ts";

describe("CLI stand seam", () => {
  it("re-reads the file at each call, fails releases on request, copies the stub as an executable", async () => {
    const d = mkdtempSync(join(tmpdir(), "cli-stand-"));
    try {
      const stub = join(d, "stub.sh");
      writeFileSync(stub, "#!/bin/sh\necho 1.2.3\n");
      chmodSync(stub, 0o644);
      const file = join(d, "stand.json");
      writeFileSync(file, JSON.stringify({ releases: { claude: ["1.2.3"] }, packages: { "claude@1.2.3": stub } }));
      const deps = standCandidateDeps(file);
      expect(await deps.releases.list("claude")).toEqual(["1.2.3"]);
      expect(await deps.releases.list("codex")).toEqual([]);
      writeFileSync(file, JSON.stringify({ releases: { claude: ["1.2.4"] }, failReleases: "stand down" }));
      await expect(deps.releases.list("claude")).rejects.toThrow("stand down");
      writeFileSync(file, JSON.stringify({ packages: { "claude@1.2.3": stub } }));
      const out = join(d, "out");
      const got = await deps.source.fetch("claude", "1.2.3", out);
      expect(got.source).toBe("stand:claude@1.2.3");
      expect(existsSync(got.executable)).toBe(true);
      expect(statSync(got.executable).mode & 0o111).not.toBe(0);
      expect(readFileSync(got.executable, "utf8")).toContain("echo 1.2.3");
      await expect(deps.source.fetch("claude", "9.9.9", out)).rejects.toThrow("not listed");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
