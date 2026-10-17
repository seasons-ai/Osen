import { appendFileSync } from "node:fs";

appendFileSync(process.env.COUNT_FILE!, "x\n");
if (process.env.MODE === "fail") process.exit(3);
process.stdout.write(JSON.stringify({ ok: true, text: "x", pages: 1 }) + "\n");
