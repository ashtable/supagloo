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
    pullsOpened: 0,
    pullsMerged: 0,
    refsCreated: 0,
  };
  const prCounters = new Map<string, number>();
  const mergedPrs = new Set<string>();

  const hasAppJwt = (auth?: string) => !!auth && /^Bearer\s+.+/.test(auth);
  const hasUserToken = (auth?: string) => !!auth && /ghu_/.test(auth);

  const routes = [
    route("GET", "/app/installations/:installationId", (ctx) => {
      ctx.send(200, {
        id: Number(ctx.params.installationId),
        app_id: 123456,
        account: { login: "acme" },
        repository_selection: "selected",
        target_type: "User",
      });
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
