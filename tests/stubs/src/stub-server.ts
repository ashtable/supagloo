import http from "node:http";
import { createCallLog } from "./call-log";
import { compilePattern, readBody } from "./http-util";

/**
 * Minimal zero-dependency HTTP stub framework on `node:http`. House style is
 * REAL listening servers (no in-process interception library exists anywhere in
 * this project), so each provider stub is a tiny real server that the unit tests
 * start in-process on an ephemeral port and the Compose overlay runs as a
 * container. Every stub gets the same `/__stub/health|calls|reset` introspection.
 */

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** Parsed request URL — `url.origin` reflects the Host the client used. */
  url: URL;
  params: Record<string, string>;
  body: Buffer;
  /** JSON body, or `undefined` if absent/unparseable. */
  json<T = unknown>(): T | undefined;
  /** Form-encoded body as URLSearchParams. */
  form(): URLSearchParams;
  /** Case-insensitive request header (first value). */
  header(name: string): string | undefined;
  send(status: number, body: unknown, headers?: Record<string, string>): void;
  sendRaw(status: number, body: Buffer, headers?: Record<string, string>): void;
  empty(status: number, headers?: Record<string, string>): void;
}

export type Handler = (ctx: RouteContext) => void | Promise<void>;

export interface Route {
  method: string;
  /** Template label used as the call-log key. */
  pattern: string;
  match(pathname: string): Record<string, string> | null;
  handler: Handler;
}

export interface StubCalls {
  total: number;
  byRoute: Record<string, number>;
  state: Record<string, unknown>;
}

export interface StubHandle {
  server: http.Server;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
  calls(): StubCalls;
  reset(): void;
}

export interface StubDefinition {
  kind: string;
  routes: Route[];
  /** Live counters surfaced under `calls().state`. */
  state: Record<string, unknown>;
  /** Clear stub-specific stores + counters on `POST /__stub/reset`. */
  onReset?: () => void;
}

export interface StartStubOptions {
  port?: number;
  host?: string;
}

/** Build a route from an Express-style `:param` template. */
export function route(method: string, pattern: string, handler: Handler): Route {
  return { method, pattern, match: compilePattern(pattern), handler };
}

/** Build a route that matches any path ending with `suffix` (git smart-HTTP). */
export function suffixRoute(
  method: string,
  suffix: string,
  handler: Handler,
): Route {
  return {
    method,
    pattern: `* ${suffix}`,
    match: (pathname: string) =>
      pathname.endsWith(suffix) ? { path: pathname } : null,
    handler,
  };
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    ...headers,
  });
  res.end(payload);
}

export function startStub(
  def: StubDefinition,
  options: StartStubOptions = {},
): Promise<StubHandle> {
  const callLog = createCallLog();
  const host = options.host ?? "127.0.0.1";

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "stub_error", message: String(err) });
      } else {
        res.end();
      }
    });
  });

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    // Introspection routes — never counted in the domain call log.
    if (pathname === "/__stub/health") {
      return sendJson(res, 200, { status: "ok", stub: def.kind });
    }
    if (pathname === "/__stub/calls") {
      return sendJson(res, 200, { ...callLog.snapshot(), state: def.state });
    }
    if (pathname === "/__stub/reset" && method === "POST") {
      callLog.reset();
      def.onReset?.();
      return sendJson(res, 200, { ok: true });
    }

    const body = await readBody(req);

    for (const r of def.routes) {
      if (r.method !== method) continue;
      const params = r.match(pathname);
      if (!params) continue;
      callLog.record(`${r.method} ${r.pattern}`);
      await r.handler(makeContext(req, res, url, params, body));
      return;
    }

    callLog.record(`${method} ${pathname} (unmatched)`);
    sendJson(res, 404, { error: "not_found", path: pathname });
  }

  function makeContext(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    params: Record<string, string>,
    body: Buffer,
  ): RouteContext {
    return {
      req,
      res,
      url,
      params,
      body,
      json<T = unknown>(): T | undefined {
        if (body.length === 0) return undefined;
        try {
          return JSON.parse(body.toString("utf8")) as T;
        } catch {
          return undefined;
        }
      },
      form(): URLSearchParams {
        return new URLSearchParams(body.toString("utf8"));
      },
      header(name: string): string | undefined {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
      send(status, payload, headers): void {
        sendJson(res, status, payload, headers);
      },
      sendRaw(status, payload, headers = {}): void {
        res.writeHead(status, {
          "content-length": String(payload.length),
          ...headers,
        });
        res.end(payload);
      },
      empty(status, headers = {}): void {
        res.writeHead(status, headers);
        res.end();
      },
    };
  }

  return new Promise<StubHandle>((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        port,
        baseUrl: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((res2, rej2) =>
            server.close((err) => (err ? rej2(err) : res2())),
          ),
        calls: () => ({ ...callLog.snapshot(), state: def.state }),
        reset: () => {
          callLog.reset();
          def.onReset?.();
        },
      });
    });
  });
}
