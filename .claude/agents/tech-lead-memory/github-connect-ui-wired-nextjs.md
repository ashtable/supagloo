---
name: github-connect-ui-wired-nextjs
description: Task 24 wired the REAL GitHub App connect flow into supagloo-nextjs — BFF connect routes, the poll-based effect layer that makes wizard pending span a real OAuth round-trip, real githubLogin/repo-count, and the e2e "simulate GitHub's redirect-back" pattern
metadata:
  type: convention
---

Built 2026-07-20 (plan task 24). TDD plan:
`scratch/task-24-github-connect-ui.md`. Edits ONLY in `~/code/supagloo-nextjs`
(branch v0.0.24). Builds on [[bff-foundation-nextjs-built]] (task 23:
`forwardToApi`, session cookie, `?seed=` seam) + [[github-app-connection-built]]
(task 11 API, unchanged). Realizes design-delta §5.3/§6a.

**The real flow (§6a), resolution = POLLING.** `connectProvider("github")` in
real/seed mode: `beginConnect` (→pending) + `window.open("/api/connect/github/start")`
+ the MAIN tab polls `GET /api/connections` until github is connected. The
`window.open` is fire-and-forget UX; correctness rides on the poll. Chosen over a
full-page redirect because that would reset the wizard's in-place step state. New
BFF routes (all thin `forwardToApi` adapters like task 23's):
- `GET /api/connect/github/start` → forwards install-url → **302 redirect** to the
  hosted GitHub App install page.
- `GET /api/connect/github/callback` → reads `installation_id` (+ `setup_action`,
  received but NEVER gates — any value proceeds; only `installationId` is
  forwarded per the diagram) → POSTs `{installationId}` to
  `/v1/connections/github/callback` → **302 redirect** to `/?github=connected|error`.
- `GET /api/connections` → passthrough of the merged `GET /v1/connections`
  (`{github|null, openrouter|null, gloo|null}` from task 12). Poll + bootstrap hydrate.
- `DELETE /api/connect/github` → passthrough of `DELETE /v1/connections/github`.
- `GET /api/github/repos` → passthrough of `/v1/github/repos` (forwards `?filter/q`).

**Effect layer is pure + injectable** (`lib/connections/github-connect.ts`): all
fetch/sleep/now/open are params, so zero-network unit-tested. Fns:
`githubUsername` (`@`-prefix), `githubSnapshotFromConnections` (loose read of the
merged body → connected+login), `fetchGithubConnection`, `fetchGithubRepoCount`
(best-effort → 0 on any failure so it NEVER blocks the connected transition / gate),
`pollGithubConnected` (immediate check then interval; DEFAULT 1200ms/120s; returns
login or null on timeout), `openGithubInstall` (swallows a blocked popup), and the
route helpers `githubCallbackRedirectTarget`/`Path`.

**Reducer kept, extended.** Added `connectGithub(state, {username, repos})` to
`connections-model.ts` (real-detail github connect) — the mocked
`completeConnect("github")` (hardcoded `@ashsrinivas`/12) is only for the still-mock
openrouter/gloo. Real detail: `username = "@"+githubLogin` (stub → `@acme`),
`repos` = live `GET /v1/github/repos` count (stub fixture = 4). The card's
`detail.repos` REQUIRED the count, so `/api/github/repos` was built (exercises the
last unused task-11 endpoint) rather than faking it.

**Mock-mode is UNTOUCHED (hard invariant).** `connectProvider`/`disconnectProvider`
branch on `parseMockSession(search, DEMO_FLAG) != null`: mock mode OR provider ≠
github → the old `beginConnect`+`setTimeout(completeConnect)` path. Real github only
in real/seed mode. Also a new bootstrap **hydrate effect** (real/seed only, gated on
`serverUser` + `connectionsSeeded`, never sets not-linked, yields to `pending`)
reflects an already-connected github on load. Kept `onboarding-wizard.e2e.ts` (mock)
+ `workspace-profile.e2e.ts` (mock connect/disconnect) green untouched.

**Contracts hand-rolled in `lib/api/contracts.ts`** (NOT db-lib — same task-23
reason): `GithubInstallUrlResponse/ConnectionStatus/ConnectionResponse/Repo/
RepoListResponse` + `ConnectionsResponse` (github typed, openrouter/gloo left
`z.unknown().nullable()` — task 25 owns them).

**Task-23 fallout:** `bff-session.e2e.ts` E-B2 clicked `connect-authorize`
expecting the MOCK 350ms auto-advance; task 24 makes github real in seed mode, so
E-B2 was UPDATED to drive the real callback. Expected, not a regression.

**E2E "simulate GitHub's redirect-back" pattern (`tests/e2e/connect-helpers.ts`
`completeGithubConnectViaCallback`).** The github-stub has REST endpoints only — no
HTML install-picker page — so a real browser can't click through fake GitHub. After
the wizard/card kicks off the connect (pending + poll), the helper opens a THROWAWAY
page in the SAME Stagehand context (`sh.context.newPage()` — shares the httpOnly
session cookie) and navigates it straight to
`/api/connect/github/callback?installation_id=42&setup_action=install`, exactly as
GitHub would. The callback stores via the real API; the main tab's poll flips to
connected. Proof of realness: the wizard Done recap shows `✓ GitHub connected ·
@acme` (the stub's `account.login`), not the mock `@ashsrinivas`.

**Live API for the e2e** (extends task 23's "start the API manually" —
`global-setup.ts` only boots/reuses `next dev`). Task 24's callback needs the API
to SIGN a real App JWT + reach the stub, so — unlike task 23's dummy github env —
run `~/code/supagloo-nodejs-api`'s `node dist/server.js` with
`GITHUB_API_BASE_URL=GITHUB_OAUTH_BASE_URL=http://localhost:4801` (the github-stub,
host port; OAUTH→stub keeps the popup off the public internet), a **freshly
generated 2048-bit RSA PKCS#1 PEM** in `GITHUB_APP_PRIVATE_KEY` (stub checks JWT
presence only, but `signAppJwt` must not crash), `GITHUB_APP_ID=123456`,
`GITHUB_APP_SLUG=supagloo-app`, `SUPAGLOO_ENABLE_TEST_SEED=1`, `NODE_ENV=test`,
`PORT=4000`, DATABASE_URL→compose `supagloo`, DBOS_DATABASE_URL→`supagloo_dbos`,
SECRETS_ENCRYPTION_KEY=64hex, dummy S3_* (validated, never called). Verified full
API path directly: seed→token, callback(42)→`githubLogin:acme`, connections→acme,
repos→4. `~/code/supagloo/scratchpad/start-api.sh` is the launcher used.

**DEFERRED (documented gap):** full profile-card (10b) real-data e2e (real @login +
live count + Disconnect on `/profile`). Reason: deep-linking `/profile` in real/seed
mode hits a redirect race (profile redirects signed-out/firstSignIn to `/` before
the async seed resolves) — orthogonal infra. The card wiring IS implemented +
unit-covered (`connectGithub`, `fetchGithubRepoCount`, `githubSnapshotFromConnections`,
`disconnect`); the core connect + real login proven via the wizard Done recap.

Final: nextjs 203 unit (25 files) green; e2e green — github-connect(3) + updated
bff-session(3) + onboarding-wizard(7, mock) + workspace-profile(9, mock).
