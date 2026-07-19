import { randomBytes } from "node:crypto";
import {
  route,
  startStub,
  type StartStubOptions,
  type StubHandle,
} from "./stub-server";

export interface GithubStubOptions extends StartStubOptions {
  /** Base URL the returned `clone_url` points at (the git-server). */
  gitServerInternalUrl?: string;
}

const sha = () => randomBytes(20).toString("hex");

/** GitHub's `per_page`: default 30, hard max 100; invalid/absent ⇒ default. */
function clampPerPage(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 30;
  return Math.min(100, n);
}

/** 1-based `page`; invalid/absent ⇒ 1. */
function clampPage(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

/** Absolute URL for a pagination page, preserving the request's host + path so
 *  the client follows the `Link` header back to this same stub. */
function pageUrl(reqUrl: URL, perPage: number, page: number): string {
  const next = new URL(reqUrl.href);
  next.searchParams.set("per_page", String(perPage));
  next.searchParams.set("page", String(page));
  return next.href;
}

/**
 * GitHub App stub — supports BOTH flows the design requires (design-delta §2.3):
 *   1. Installation-token flow: verify installation, App-JWT -> installation
 *      token (used by every git-ops workflow's mintInstallationToken step), open
 *      + merge PRs, create tags.
 *   2. JIT zero-storage user-token hop (create-new-repo): code -> short-lived
 *      user token -> POST /user/repos -> add repo to a `selected` installation.
 */
export function createGithubStub(
  options: GithubStubOptions = {},
): Promise<StubHandle> {
  const gitServerInternalUrl =
    options.gitServerInternalUrl ??
    process.env.GIT_SERVER_INTERNAL_URL ??
    "http://git-server:8080";

  const state = {
    installationTokensIssued: 0,
    userTokensIssued: 0,
    reposCreated: 0,
    reposAddedToInstallation: 0,
    reposListed: 0,
    pullsOpened: 0,
    pullsMerged: 0,
    refsCreated: 0,
  };
  const prCounters = new Map<string, number>();
  const mergedPrs = new Set<string>();

  const hasAppJwt = (auth?: string) => !!auth && /^Bearer\s+.+/.test(auth);
  const hasUserToken = (auth?: string) => !!auth && /ghu_/.test(auth);
  // An installation token (real prefix `ghs_`), accepted as `token …` or `Bearer …`.
  const hasInstallationToken = (auth?: string) => !!auth && /ghs_/.test(auth);

  // Deterministic repos the installation can access (Task #11 repo listing). Mixed
  // `size`: 0 ⇒ the API derives `empty:true` (no commits yet), >0 ⇒ non-empty. The
  // stub returns ALL of them; the API applies filter=empty|all and q= in-process.
  const installationRepos = [
    { id: 101, name: "empty-one", full_name: "acme/empty-one", private: true, default_branch: "main", size: 0 },
    { id: 102, name: "empty-two", full_name: "acme/empty-two", private: false, default_branch: "main", size: 0 },
    { id: 103, name: "psalms-video", full_name: "acme/psalms-video", private: true, default_branch: "main", size: 512 },
    { id: 104, name: "genesis-app", full_name: "acme/genesis-app", private: false, default_branch: "main", size: 128 },
  ];

  const routes = [
    route("GET", "/app/installations/:installationId", (ctx) => {
      // Real GitHub requires an App JWT here (Task #11) — presence/shape only; the
      // stub has no public key, so RS256 correctness is db-lib's unit-test job.
      if (!hasAppJwt(ctx.header("authorization"))) {
        return ctx.send(401, { message: "Requires authentication" });
      }
      ctx.send(200, {
        id: Number(ctx.params.installationId),
        app_id: 123456,
        account: { login: "acme" },
        repository_selection: "selected",
        target_type: "User",
      });
    }),

    route("GET", "/installation/repositories", (ctx) => {
      // Authenticated with a minted INSTALLATION token (not the App JWT, not a
      // user token) — proves the API minted one for this request.
      if (!hasInstallationToken(ctx.header("authorization"))) {
        return ctx.send(401, { message: "Requires authentication" });
      }
      state.reposListed += 1;

      // Real GitHub PAGINATES this endpoint (default 30, max 100 per_page) and
      // signals more pages via an RFC 5988 `Link: rel="next"` header. Modelling
      // that here is what lets a test force >1 page (e.g. per_page=2 over the
      // 4-repo fixture) and catch a client that trusts a single response and
      // silently truncates the list. Returning everything in one shot — as this
      // stub used to — hides that data-loss bug.
      const perPage = clampPerPage(ctx.url.searchParams.get("per_page"));
      const page = clampPage(ctx.url.searchParams.get("page"));
      const all = installationRepos.map((r) => ({ ...r, owner: { login: "acme" } }));
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const hasNext = start + perPage < all.length;

      const headers: Record<string, string> = {};
      if (hasNext) {
        const lastPage = Math.ceil(all.length / perPage);
        headers.link = [
          `<${pageUrl(ctx.url, perPage, page + 1)}>; rel="next"`,
          `<${pageUrl(ctx.url, perPage, lastPage)}>; rel="last"`,
        ].join(", ");
      }

      ctx.send(200, { total_count: all.length, repositories: slice }, headers);
    }),

    route(
      "POST",
      "/app/installations/:installationId/access_tokens",
      (ctx) => {
        if (!hasAppJwt(ctx.header("authorization"))) {
          return ctx.send(401, { message: "Requires authentication" });
        }
        state.installationTokensIssued += 1;
        ctx.send(201, {
          token: `ghs_stub_inst_${ctx.params.installationId}_${state.installationTokensIssued}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions: { contents: "write", pull_requests: "write" },
          repository_selection: "selected",
        });
      },
    ),

    route("POST", "/login/oauth/access_token", (ctx) => {
      const code = ctx.json<{ code?: string }>()?.code ?? ctx.form().get("code");
      if (!code) {
        return ctx.send(400, { error: "bad_verification_code" });
      }
      state.userTokensIssued += 1;
      ctx.send(200, {
        access_token: `ghu_stub_user_${state.userTokensIssued}`,
        token_type: "bearer",
        scope: "repo",
      });
    }),

    route("POST", "/user/repos", (ctx) => {
      if (!hasUserToken(ctx.header("authorization"))) {
        return ctx.send(401, { message: "Requires authentication" });
      }
      const req = ctx.json<{ name?: string; private?: boolean }>() ?? {};
      const name = req.name ?? "untitled";
      state.reposCreated += 1;
      ctx.send(201, {
        id: state.reposCreated,
        name,
        full_name: `acme/${name}`,
        private: !!req.private,
        owner: { login: "acme" },
        default_branch: "main",
        clone_url: `${gitServerInternalUrl}/acme/${name}.git`,
      });
    }),

    route(
      "PUT",
      "/user/installations/:installationId/repositories/:repositoryId",
      (ctx) => {
        if (!hasUserToken(ctx.header("authorization"))) {
          return ctx.send(401, { message: "Requires authentication" });
        }
        state.reposAddedToInstallation += 1;
        ctx.empty(204);
      },
    ),

    route("POST", "/repos/:owner/:repo/pulls", (ctx) => {
      const key = `${ctx.params.owner}/${ctx.params.repo}`;
      const number = (prCounters.get(key) ?? 0) + 1;
      prCounters.set(key, number);
      state.pullsOpened += 1;
      const req =
        ctx.json<{ title?: string; head?: string; base?: string }>() ?? {};
      ctx.send(201, {
        number,
        html_url: `${ctx.url.origin}/${key}/pull/${number}`,
        state: "open",
        merged: false,
        title: req.title ?? "",
        head: { ref: req.head ?? "" },
        base: { ref: req.base ?? "main" },
      });
    }),

    route("PUT", "/repos/:owner/:repo/pulls/:number/merge", (ctx) => {
      const key = `${ctx.params.owner}/${ctx.params.repo}#${ctx.params.number}`;
      if (mergedPrs.has(key)) {
        return ctx.send(405, { message: "Pull Request is not mergeable" });
      }
      mergedPrs.add(key);
      state.pullsMerged += 1;
      ctx.send(200, {
        merged: true,
        sha: sha(),
        message: "Pull Request successfully merged",
      });
    }),

    route("POST", "/repos/:owner/:repo/git/refs", (ctx) => {
      const req = ctx.json<{ ref?: string; sha?: string }>() ?? {};
      state.refsCreated += 1;
      ctx.send(201, {
        ref: req.ref ?? "",
        object: { sha: req.sha ?? sha(), type: "commit" },
      });
    }),
  ];

  return startStub(
    {
      kind: "github",
      routes,
      state,
      onReset: () => {
        for (const k of Object.keys(state) as (keyof typeof state)[]) {
          state[k] = 0;
        }
        prCounters.clear();
        mergedPrs.clear();
      },
    },
    options,
  );
}
