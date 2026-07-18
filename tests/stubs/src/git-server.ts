import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  route,
  startStub,
  suffixRoute,
  type RouteContext,
  type StartStubOptions,
  type StubHandle,
} from "./stub-server";

export interface GitServerOptions extends StartStubOptions {
  /** Where bare repos live. Defaults to a fresh temp dir (or $GIT_REPOS_ROOT). */
  reposRoot?: string;
}

/**
 * Repo names accepted by `POST /__admin/repos`. The name is interpolated into a
 * filesystem path (`<reposRoot>/<name>.git`), so it must be a single
 * `owner/repo`-shaped slug — no `..`, no leading `/`, no path separators beyond
 * one segment boundary. Rejecting anything else closes a path-traversal hole
 * (e.g. `../outside/pwn` would otherwise create a bare repo above reposRoot).
 * GitHub repos are `owner/repo`, matching the harness's real usage
 * (`acme/demo-<ts>`).
 */
const REPO_NAME_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/;

/** Name of the internal scratch repo used only by the readiness warm-up. */
const HEALTH_REPO = "__health";

const HERMETIC_GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Supagloo Stub",
  GIT_AUTHOR_EMAIL: "stub@supagloo.local",
  GIT_COMMITTER_NAME: "Supagloo Stub",
  GIT_COMMITTER_EMAIL: "stub@supagloo.local",
};

/** Locate the dir holding `git-http-backend` (host + container differ). */
function gitCorePath(): string {
  return execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
}

/** Split a CGI response buffer into its header block and body. */
function splitCgi(out: Buffer): { headers: string; body: Buffer } {
  let idx = out.indexOf("\r\n\r\n");
  let len = 4;
  if (idx < 0) {
    idx = out.indexOf("\n\n");
    len = 2;
  }
  if (idx < 0) return { headers: "", body: out };
  return { headers: out.subarray(0, idx).toString("utf8"), body: out.subarray(idx + len) };
}

interface CgiResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Local git smart-HTTP server backed by real bare repos, serving upload-pack
 * (clone/fetch) and receive-pack (push) by shelling out to the system
 * `git-http-backend` CGI. Zero npm deps. Enables the real clone/branch/commit/
 * push/merge/tag cycle the git-ops DBOS workflows drive (design-delta §7); the
 * "PR open/merge" REST half is on the github stub. Supports arbitrary semver
 * branch names (v0.0.1, v0.2.3, ...), not just v0.0.N.
 */
export async function createGitServer(
  options: GitServerOptions = {},
): Promise<StubHandle> {
  const reposRoot =
    options.reposRoot ??
    process.env.GIT_REPOS_ROOT ??
    mkdtempSync(join(tmpdir(), "supagloo-git-server-"));
  mkdirSync(reposRoot, { recursive: true });
  const gitCore = gitCorePath();

  const state = { reposCreated: 0, uploadPackRequests: 0, receivePackRequests: 0 };

  function seedRepo(repoPath: string, branch: string): void {
    const work = mkdtempSync(join(tmpdir(), "supagloo-git-seed-"));
    const env = { ...process.env, ...HERMETIC_GIT_ENV };
    try {
      execFileSync("git", ["init", `--initial-branch=${branch}`, work], { env });
      writeFileSync(join(work, "README.md"), "# seeded by git-server stub\n");
      execFileSync("git", ["-C", work, "add", "-A"], { env });
      execFileSync("git", ["-C", work, "commit", "-m", "initial commit"], { env });
      execFileSync("git", ["-C", work, "remote", "add", "origin", repoPath], { env });
      execFileSync("git", ["-C", work, "push", "origin", `refs/heads/${branch}`], { env });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Idempotently create a bare repo (optionally seeded) under reposRoot. */
  function ensureRepo(name: string, opts: { seed: boolean; branch: string }): void {
    const repoPath = join(reposRoot, `${name}.git`);
    if (existsSync(repoPath)) return;
    mkdirSync(dirname(repoPath), { recursive: true });
    execFileSync("git", ["init", "--bare", `--initial-branch=${opts.branch}`, repoPath]);
    execFileSync("git", ["-C", repoPath, "config", "http.receivepack", "true"]);
    execFileSync("git", ["-C", repoPath, "config", "http.uploadpack", "true"]);
    if (opts.seed) seedRepo(repoPath, opts.branch);
  }

  /**
   * Low-level `git-http-backend` CGI invocation. Builds the CGI env, pipes the
   * request body to stdin, and parses the CGI response (Status: line + headers +
   * binary body). Shared by the real smart-HTTP routes and the readiness probe.
   */
  function invokeBackend(params: {
    pathInfo: string;
    queryString: string;
    method: string;
    contentType: string;
    body: Buffer;
    httpHeaders?: Record<string, string | string[] | undefined>;
  }): Promise<CgiResult> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: reposRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: params.pathInfo,
      QUERY_STRING: params.queryString,
      REQUEST_METHOD: params.method,
      CONTENT_TYPE: params.contentType,
      CONTENT_LENGTH: String(params.body.length),
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "stub",
    };
    // Forward remaining request headers as CGI HTTP_* vars (Content-Encoding,
    // Git-Protocol v2, etc.) so git-http-backend behaves like a real CGI host.
    for (const [key, value] of Object.entries(params.httpHeaders ?? {})) {
      if (key === "content-type" || key === "content-length") continue;
      if (value === undefined) continue;
      env[`HTTP_${key.toUpperCase().replace(/-/g, "_")}`] = Array.isArray(value)
        ? value.join(", ")
        : value;
    }

    return new Promise<CgiResult>((resolve, reject) => {
      const child = spawn(join(gitCore, "git-http-backend"), [], { env });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("close", () => {
        const { headers, body } = splitCgi(Buffer.concat(chunks));
        let status = 200;
        const outHeaders: Record<string, string> = {};
        for (const line of headers.split(/\r?\n/)) {
          const sep = line.indexOf(":");
          if (sep < 0) continue;
          const name = line.slice(0, sep).trim();
          const val = line.slice(sep + 1).trim();
          if (name.toLowerCase() === "status") status = parseInt(val, 10) || 200;
          else outHeaders[name] = val;
        }
        resolve({ status, headers: outHeaders, body });
      });
      child.stdin.write(params.body);
      child.stdin.end();
    });
  }

  async function runBackend(ctx: RouteContext): Promise<void> {
    const pathname = ctx.url.pathname;
    if (pathname.endsWith("git-receive-pack") || ctx.url.searchParams.get("service") === "git-receive-pack") {
      state.receivePackRequests += 1;
    }
    if (pathname.endsWith("git-upload-pack") || ctx.url.searchParams.get("service") === "git-upload-pack") {
      state.uploadPackRequests += 1;
    }

    const result = await invokeBackend({
      pathInfo: pathname,
      queryString: ctx.url.search.replace(/^\?/, ""),
      method: ctx.req.method ?? "GET",
      contentType: ctx.header("content-type") ?? "",
      body: ctx.body,
      httpHeaders: ctx.req.headers,
    });
    // Fresh connection per request: git makes only a handful of requests per
    // clone/push, and keep-alive reuse across the CGI hand-off stalls the
    // client ~11s while it waits for the socket to free up.
    result.headers.Connection = "close";
    ctx.res.writeHead(result.status, result.headers);
    ctx.res.end(result.body);
  }

  /**
   * Deep readiness probe (memoized). `/__stub/health` gating solely on the HTTP
   * listener answers "ready" before any `git-http-backend` CGI has ever spawned,
   * so a freshly-built container can report healthy while the harness's very
   * first real git op still races the cold CGI spawn ("Empty reply from
   * server"). This forces one real `info/refs?service=git-upload-pack` CGI
   * round-trip against a seeded scratch repo first; once it succeeds we cache
   * `true` (subsequent probes are free). A single in-flight probe is shared by
   * concurrent callers, and a failed probe is retried on the next call.
   */
  let ready = false;
  let inflight: Promise<boolean> | undefined;
  async function doProbe(): Promise<boolean> {
    try {
      ensureRepo(HEALTH_REPO, { seed: true, branch: "main" });
      const result = await invokeBackend({
        pathInfo: `/${HEALTH_REPO}.git/info/refs`,
        queryString: "service=git-upload-pack",
        method: "GET",
        contentType: "",
        body: Buffer.alloc(0),
      });
      return result.status === 200 && result.body.length > 0;
    } catch {
      return false;
    }
  }
  function probeReady(): Promise<boolean> {
    if (ready) return Promise.resolve(true);
    if (!inflight) {
      inflight = doProbe().then((ok) => {
        ready = ok;
        inflight = undefined; // clear so a failed probe retries next call
        return ok;
      });
    }
    return inflight;
  }

  const routes = [
    route("POST", "/__admin/repos", (ctx) => {
      const body =
        ctx.json<{ name?: string; seed?: boolean; defaultBranch?: string }>() ?? {};
      if (!body.name) return ctx.send(400, { error: "name_required" });
      if (!REPO_NAME_RE.test(body.name)) {
        return ctx.send(400, {
          error: "invalid_name",
          message:
            "repo name must match ^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)?$ (owner/repo slug; no path traversal)",
        });
      }
      const branch = body.defaultBranch ?? "main";
      ensureRepo(body.name, { seed: Boolean(body.seed), branch });
      state.reposCreated += 1;
      ctx.send(201, { name: body.name, defaultBranch: branch });
    }),

    suffixRoute("GET", "/info/refs", runBackend),
    suffixRoute("POST", "/git-upload-pack", runBackend),
    suffixRoute("POST", "/git-receive-pack", runBackend),
  ];

  return startStub(
    {
      kind: "git",
      routes,
      state,
      onReset: () => {
        state.reposCreated = 0;
        state.uploadPackRequests = 0;
        state.receivePackRequests = 0;
      },
      readyCheck: probeReady,
    },
    options,
  );
}
