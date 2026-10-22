import "../pdf/guard.ts";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { listArchive, readArchive } from "./archive.ts";
import { extractDocument } from "./detect.ts";

// ponytail: the supervisor below is copied from pdf/pdf-extract.ts; extract a shared module when a third consumer appears.
// One file is both the child process (main thread) and its extraction thread, so the app ships exactly one doc-extract.mjs.
if (isMainThread) {
  const { ms, rssBytes, chars, parts, unpackedBytes, ratio, cells, worker, mode, indices } = JSON.parse(process.argv[2]!) as {
    ms: number; rssBytes: number; chars: number; parts: number; unpackedBytes: number; ratio: number; cells: number; worker?: string; mode?: "list" | "read"; indices?: number[];
  };
  let done = false;
  let thread: Worker | undefined;

  const finish = (result: object): void => {
    if (done) return;
    done = true;
    void thread?.terminate();
    process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
  };

  const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), ms);
  const watch = setInterval(() => {
    if (process.memoryUsage.rss() > rssBytes) finish({ ok: false, code: "memory" });
  }, 50);
  void timer; void watch;

  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const bytes = new Uint8Array(Buffer.concat(chunks));

  if (!done) {
    thread = new Worker(worker ?? import.meta.filename, {
      workerData: { bytes, mode, indices, limits: { chars, parts, unpackedBytes, ratio, cells } }, transferList: [bytes.buffer], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: Math.ceil(rssBytes / 2 ** 20) },
    });
    thread.on("message", (result) => finish(result));
    // extractDocument catches parse errors itself: an error or exit here is an unexpected failure, not a damaged document
    thread.on("error", (e) => finish((e as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? { ok: false, code: "memory" } : { ok: false, code: "failed", detail: "worker error" }));
    thread.on("exit", () => finish({ ok: false, code: "failed", detail: "worker exit" }));
  }
} else {
  const { bytes, mode, indices, limits } = workerData;
  parentPort!.postMessage(mode === "list" ? listArchive(bytes, limits) : mode === "read" ? readArchive(bytes, indices ?? [], limits) : extractDocument(bytes, limits));
}
