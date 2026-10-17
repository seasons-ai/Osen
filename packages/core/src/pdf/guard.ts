import net from "node:net";
import { materialsMessages } from "../messages/materials.ts";

// The network in the extraction thread is closed completely: fetch and sockets (http, https, tls go through them).
const deny = (): never => { throw new Error(materialsMessages().networkClosed); };
globalThis.fetch = deny as unknown as typeof fetch;
net.Socket.prototype.connect = deny as unknown as typeof net.Socket.prototype.connect;
