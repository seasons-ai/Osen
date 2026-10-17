import "./guard.ts";
import { parentPort, workerData } from "node:worker_threads";
import { extractText } from "./pdf-text.ts";

parentPort!.postMessage(await extractText(workerData.bytes, workerData));
