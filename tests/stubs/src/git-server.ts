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

/**
 * Local git smart-HTTP server backed by real bare repos, serving upload-pack
 * (clone/fetch) and receive-pack (push) by shelling out to the system
 * `git-http-backend` CGI. Zero npm deps. Enables the real clone/branch/commit/
 * push/merge/tag cycle the git-ops DBOS workflows drive (design-delta §7); the
 * "PR open/merge" REST half is on the github stub. Supports arbitrary semver
 * branch names (v0.0.1, v0.2.3, ...), not just v0.0.N.
 */
export function createGitServer(
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

  function runBackend(ctx: RouteContext): Promise<void> {
    const pathname = ctx.url.pathname;
    if (pathname.endsWith("git-receive-pack") || ctx.url.searchParams.get("service") === "git-receive-pack") {
      state.receivePackRequests += 1;
    }
    if (pathname.endsWith("git-upload-pack") || ctx.url.searchParams.get("service") === "git-upload-pack") {
      state.uploadPackRequests += 1;
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_PROJECT_ROOT: reposRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathname,
      QUERY_STRING: ctx.url.search.replace(/^\?/, ""),
      REQUEST_METHOD: ctx.req.method ?? "GET",
      CONTENT_TYPE: ctx.header("content-type") ?? "",
      CONTENT_LENGTH: String(ctx.body.length),
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "stub",
    };
    // Forward remaining request headers as CGI HTTP_* vars (Content-Encoding,
    // Git-Protocol v2, etc.) so git-http-backend behaves like a real CGI host.
    for (const [key, value] of Object.entries(ctx.req.headers)) {
      if (key === "content-type" || key === "content-length") continue;
      if (value === undefined) continue;
      env[`HTTP_${key.toUpperCase().replace(/-/g, "_")}`] = Array.isArray(value)
        ? value.join(", ")
        : value;
    }

    return new Promise<void>((resolve, reject) => {
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
        // Fresh connection per request: git makes only a handful of requests per
        // clone/push, and keep-alive reuse across the CGI hand-off stalls the
        // client ~11s while it waits for the socket to free up.
        outHeaders.Connection = "close";
        ctx.res.writeHead(status, outHeaders);
        ctx.res.end(body);
        resolve();
      });
      child.stdin.write(ctx.body);
      child.stdin.end();
    });
  }

  const routes = [
    route("POST", "/__admin/repos", (ctx) => {
      const body =
        ctx.json<{ name?: string; seed?: boolean; defaultBranch?: string }>() ?? {};
      if (!body.name) return ctx.send(400, { error: "name_required" });
      const branch = body.defaultBranch ?? "main";
      const repoPath = join(reposRoot, `${body.name}.git`);
      if (!existsSync(repoPath)) {
        mkdirSync(dirname(repoPath), { recursive: true });
        execFileSync("git", ["init", "--bare", `--initial-branch=${branch}`, repoPath]);
        execFileSync("git", ["-C", repoPath, "config", "http.receivepack", "true"]);
        execFileSync("git", ["-C", repoPath, "config", "http.uploadpack", "true"]);
        if (body.seed) seedRepo(repoPath, branch);
      }
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
    },
    options,
  );
}
