import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { stack } from "./api";

/**
 * A fault-injecting proxy in front of RustFS (phase 3 §17.15 T3-02): it forwards S3 requests
 * unchanged (the SigV4 Host header included, so signatures still verify) and fails the ones the
 * test picks, with an S3 error status or a dropped connection. Test support only; no package.
 */

export type Fault = {
  method: string;
  times: number;
  kind: 500 | 503 | "drop";
  /** Only requests carrying this header, e.g. x-amz-copy-source for CopyObject (a PUT, like a tombstone). */
  header?: string;
};

export type FaultProxy = {
  endpoint: string;
  /** Add faults; each fails the next `times` requests with that method. */
  fail(fault: Fault): void;
  /** Requests seen, as "METHOD status" ("DROP" for dropped connections). */
  seen: string[];
  close(): Promise<void>;
};

export async function startFaultProxy(): Promise<FaultProxy> {
  const target = new URL(stack().storage.endpoint);
  const faults: Fault[] = [];
  const seen: string[] = [];

  const server: Server = createServer((req: IncomingMessage, res) => {
    const fault = faults.find((f) => f.method === req.method && f.times > 0 && (f.header === undefined || req.headers[f.header] !== undefined));
    if (fault) {
      fault.times--;
      if (fault.kind === "drop") {
        seen.push(`${req.method} DROP`);
        req.socket.destroy();
        return;
      }
      seen.push(`${req.method} ${fault.kind}`);
      req.resume();
      res.writeHead(fault.kind, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${fault.kind === 503 ? "SlowDown" : "InternalError"}</Code></Error>`);
      return;
    }
    const upstream = request(
      { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        seen.push(`${req.method} ${up.statusCode}`);
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fault proxy has no port");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    fail: (fault) => faults.push({ ...fault }),
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
