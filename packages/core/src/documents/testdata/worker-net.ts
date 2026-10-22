import net from "node:net";
import { parentPort } from "node:worker_threads";

// Runs the real doc-extract.ts module inside the extraction thread (so its guard import applies), holds back its own reply, then probes the network.
const post = parentPort!.postMessage.bind(parentPort);
parentPort!.postMessage = () => {};
await import("../doc-extract.ts");
const port = Number(process.env.NET_PORT);
const out: Record<string, string> = {};
try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); out.fetch = "passed"; } catch (e) { out.fetch = (e as Error).name === "TimeoutError" ? "passed" : "refused"; }
try { net.connect(port, "127.0.0.1").on("error", () => {}); out.net = "passed"; } catch { out.net = "refused"; }
await new Promise((ok) => setTimeout(ok, 300));
post({ ok: true, text: JSON.stringify(out), format: "probe" });
