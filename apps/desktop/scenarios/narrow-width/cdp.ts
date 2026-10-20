// CDP client over WebSocket for the scenario stands: sends commands and matches responses by numeric id.
export type Cdp = { send: (method: string, params?: object) => Promise<any>; close: () => void };
export async function connect(ws: string): Promise<Cdp> {
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
  let id = 0;
  const wait = new Map<number, (m: any) => void>();
  sock.onmessage = (e) => { const m = JSON.parse(String(e.data)); const cb = wait.get(m.id); wait.delete(m.id); if (typeof cb === "function") cb(m); };
  return {
    send: (method, params = {}) => new Promise((ok, fail) => {
      const n = ++id;
      wait.set(n, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      sock.send(JSON.stringify({ id: n, method, params }));
    }),
    close: () => sock.close()
  };
}
