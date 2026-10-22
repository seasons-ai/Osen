import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ImageFormat } from "./image-header.ts";

/** Test image with the given lines drawn on it (macOS, bin/osen-ocr-fixture built by scripts/build-ocr.ts). webp is not writable by ImageIO. */
export function makeImage(format: Exclude<ImageFormat, "webp">, lines: string[], opts: { width?: number; height?: number } = {}): Buffer {
  const bin = join(import.meta.dirname, "bin/osen-ocr-fixture");
  if (!existsSync(bin)) throw new Error(`osen-ocr-fixture is missing at ${bin} — run: npm run build:ocr`);
  const args = [format, ...(opts.width ? ["--width", String(opts.width)] : []), ...(opts.height ? ["--height", String(opts.height)] : []), ...lines];
  const r = spawnSync(bin, args, { maxBuffer: 200 * 2 ** 20 });
  if (r.status !== 0) throw new Error(`osen-ocr-fixture failed: ${r.stderr?.toString() ?? r.error?.message}`);
  return r.stdout;
}
