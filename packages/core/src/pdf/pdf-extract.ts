import { Worker } from "node:worker_threads";
import { extname, join } from "node:path";

const { pages, chars, ms, rssBytes, worker } = JSON.parse(process.argv[2]!) as {
  pages: number; chars: number; ms: number; rssBytes: number; worker?: string;
};
let done = false;
let thread: Worker | undefined;

function finish(result: object): void {
  if (done) return;
  done = true;
  void thread?.terminate();
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
}

const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), ms);
const watch = setInterval(() => {
  if (process.memoryUsage.rss() > rssBytes) finish({ ok: false, code: "memory" });
}, 50);
void timer; void watch;

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const bytes = new Uint8Array(Buffer.concat(chunks));

if (!done) {
  const file = worker ?? join(import.meta.dirname, "pdf-worker" + extname(import.meta.filename));
  thread = new Worker(file, {
    workerData: { bytes, pages, chars }, transferList: [bytes.buffer], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: Math.ceil(rssBytes / 2 ** 20) },
  });
  thread.on("message", (result) => finish(result));
  thread.on("error", (e) => finish({ ok: false, code: (e as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "damaged" }));
  thread.on("exit", () => finish({ ok: false, code: "damaged" }));
}
