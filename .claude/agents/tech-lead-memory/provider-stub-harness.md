---
name: provider-stub-harness
description: Task 9 (M2) built the provider-stub e2e harness — env-overridable base URLs, containerized zero-dep stubs (github/openrouter/gloo/youversion) + local git smart-HTTP server, docker-compose.test.yml overlay; conventions tasks 10-47 point at
metadata:
  type: convention
---

Built 2026-07-18 (plan task 9, completes M2). The as-built realization of
[[e2e-test-infra-conventions]]. Deterministic outbound-provider harness every
later e2e (tasks 10-47) points at. NEVER ships in production images.

**Stub servers** live in the ROOT repo at `tests/stubs/src/` — zero-dependency
`node:http` factories (`createGithubStub`/`createOpenRouterStub`/`createGlooStub`/
`createYouVersionStub`/`createGitServer`), each returning a `StubHandle`
(`baseUrl`, `close()`, `calls()`, `reset()`). Zero-dep so ROOT unit tests
`import` and start them IN-PROCESS on ephemeral ports (fast, isolated — house
style, no msw/nock anywhere). Shared framework `stub-server.ts` (`route()`/
`suffixRoute()` builders + dispatch) + `call-log.ts`. Every stub mounts
`/__stub/health` (readiness), `/__stub/calls` → `{total, byRoute, state}`,
`POST /__stub/reset` (test isolation). **Call-count bookkeeping**: `byRoute` keys
by route TEMPLATE (request counts); `state` holds stub-specific counters. Their
difference proves idempotency — e.g. two video submits with the same
`Idempotency-Key` give `byRoute["POST /api/v1/videos"]=2` but
`state.videoJobsCreated=1` (the seam the video workflow's crash/replay relies on).

**Containerization**: ONE image (`tests/stubs/Dockerfile`, node:22-slim + git +
tsx), selected by `STUB_KIND`, entry `src/main.ts`. Runs as 5 services in
**`docker-compose.test.yml`** (NOT `docker-compose.override.yml` — that's
gitignored, auto-merged, claimed by task 8). Invoked EXPLICITLY with `-f`; the
`api` service gets provider-URL overrides pointing at the internal stub names.
Dual-endpoint (like S3): internal `http://github-stub:8080` (API container) vs
host ports **4801 github / 4802 openrouter / 4803 gloo / 4804 youversion /
4805 git-server** (host e2e self-test, in `dev-config.ts` `PROVIDERS`).

**Env base-URL convention** (`supagloo-nodejs-api/src/config/env.ts`): five vars
`GITHUB_API_BASE_URL`(=https://api.github.com), `GITHUB_OAUTH_BASE_URL`
(=https://github.com — GitHub splits REST vs OAuth hosts), `OPENROUTER_BASE_URL`
(=https://openrouter.ai), `GLOO_BASE_URL`(=https://platform.ai.gloo.com),
`YOUVERSION_BASE_URL`(=https://api.youversion.com — INVENTED, verify at impl).
`refine`-based http(s) check (not zod `.url()`, matching DATABASE_URL). Real
defaults ⇒ prod needs zero config; overlay overrides to stub URLs. **DBOS (task
15) MUST adopt these 5 var names + defaults verbatim** — no code added to the
skeleton now.

**global-setup extension**: `INFRA_SERVICES` += 5 stubs; `infraReady()` +=
`stubsReady()` (GET each `/__stub/health`); `compose()` now builds an `-f` file
list (base + override-if-exists + test overlay). Reuse-or-spawn unchanged.

**git smart-HTTP server GOTCHAS** (both cost real time to find):
1. Serves clone/push by shelling `git-http-backend` CGI (located via
   `git --exec-path`; forward request headers as CGI `HTTP_*` for gzip +
   protocol-v2). MUST set `Connection: close` on every CGI response — keep-alive
   reuse across the CGI hand-off stalls the git client ~11s/request.
2. Driving git against an IN-PROCESS server DEADLOCKS: `execFileSync("git",...)`
   blocks the event loop so the same-process server can't answer. The git-server
   is therefore validated ONLY by the containerized e2e (separate process, host
   `git` CLI) — there is deliberately no in-process git unit test. Use hermetic
   git env in tests: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
   `GIT_TERMINAL_PROMPT=0`, explicit author/committer.

**PR vs git split**: clone/branch/commit/push/merge/tag = real git (git-server);
"PR open/merge" = GitHub REST (github stub `POST …/pulls`, `PUT …/pulls/:n/merge`).
Task 9 self-tests each in isolation; wiring the stub merge endpoint to actually
merge the backing repo is tasks 17+ integration.

Plan doc: `scratch/task-9-provider-stub-e2e-harness.md`.
