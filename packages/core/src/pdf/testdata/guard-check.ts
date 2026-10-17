import "../guard.ts";
import net from "node:net";

const port = Number(process.argv[2]);
const out: Record<string, string> = {};
try { await fetch(`http://127.0.0.1:${port}/`); out.fetch = "прошёл"; } catch { out.fetch = "отказ"; }
try { net.connect(port, "127.0.0.1").on("error", () => {}); out.net = "прошёл"; } catch { out.net = "отказ"; }
process.stdout.write(JSON.stringify(out));
setTimeout(() => process.exit(0), 200);
