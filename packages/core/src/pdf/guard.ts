import net from "node:net";
import { materialsMessages } from "../messages/materials.ts";

// ponytail: defense in depth, not a sandbox: fetch and net.Socket.connect are denied (http, https, tls go through them);
// dgram, dns and http2 are not, the extractor does not use them. A real network sandbox for the process is separate work.
const deny = (): never => { throw new Error(materialsMessages().networkClosed); };
globalThis.fetch = deny as unknown as typeof fetch;
net.Socket.prototype.connect = deny as unknown as typeof net.Socket.prototype.connect;
