import "../pdf/guard.ts"; // the network in the thread is closed
import { parentPort, workerData } from "node:worker_threads";
import { htmlToText } from "./html-text.ts";

parentPort!.postMessage({ text: htmlToText(workerData.html) });
