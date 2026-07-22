---
name: workspace-project-wizards-wired-nextjs
description: Task 26 (M4) wired the workspace + project wizards off mocks — the create-new-repo JIT user-auth hop (API + db-lib + BFF), the provisioning-log data-source swap (fake ticker → polled ProjectJob.stages), real repo pickers + project grid, honest §9-Q4 copy, and disabled votd/passage/demo cards
metadata:
  type: convention
---

Built 2026-07-21 (plan task 26, M4). TDD plan:
`scratch/task-26-workspace-project-wizards.md`. Edits across THREE repos
(`supagloo-database-lib`, `supagloo-nodejs-api`, `supagloo-nextjs`). Builds on
[[api-job-creation-polling-built]] (18), task 19 import, [[github-connect-ui-wired-nextjs]]
(24), [[openrouter-gloo-connect-ui-wired-nextjs]] (25). Realizes design-delta
§5.3 rows 4-5, §9-Q4, §2.3/§6b, §1 descope.

**SCOPE DECISION = option (a): the create-new-repo JIT hop backend was IN-SCOPE**
(the plan table said `nextjs` only, but the task's own e2e requirement is
unsatisfiable without it; db-lib schema comments + task-11 memory both point at
task 26 as the build site). So db-lib + api were touched too.

**The JIT create-new-repo hop (§2.3/§6b) — API side.** Installation tokens can't
create a repo in a user account, so a one-time ZERO-STORAGE user-token dance runs
BEFORE the existing scaffold create path:
- db-lib `schemas.ts`: `RepoAuthorizeUrlQuerySchema` (`{redirectUri, state}`),
  `RepoAuthorizeUrlResponseSchema` (`{url}`), `CreateRepoRequestSchema`
  (`{code, name?, repoName, visibility, createdFrom}`). Response reuses
  `CreateProjectResponseSchema` (`{projectId, jobId}`).
- api `src/connections/github-user-auth-client.ts` — `makeGithubUserAuthClient({
  oauthBaseUrl, apiBaseUrl, clientId, clientSecret, fetchImpl?})` → `buildAuthorizeUrl`
  (no network) / `exchangeCode(code)→{token}` (`POST {oauth}/login/oauth/access_token`
  → `ghu_` token) / `createUserRepo({token,name,private})` (`POST {api}/user/repos`,
  `authorization: token ghu_…`) / `addRepoToInstallation` (`PUT
  {api}/user/installations/:id/repositories/:repoId`, 204). Mirrors
  `github-app-client.ts` (injectable fetch, hand-built Response unit tests).
- api `src/projects/repo-provisioning-service.ts` — `RepoProvisioningService({prisma,
  userAuthClient, createProject})`: `authorizeUrl(...)`; `createRepoAndProject(userId,
  req)` reads GithubConnection (installationId+repositorySelection; none → reuse
  `GithubNotConnectedError` 409) → exchange → create repo → (`selected` mode only)
  add-to-installation → discard token → **delegate to the injected `createProject`
  seam** (= task-18 `ProjectJobsService.createProjectWithScaffold`) with the
  GitHub-assigned owner. `createProject` folded IN so ONE call returns `{projectId,
  jobId}` and the wizard polls the scaffold job like the use-existing path. Provider
  failure → new `RepoCreationError` (502 `repo_creation_failed`), in
  `src/projects/repo-provisioning-errors.ts`.
- Routes `src/routes/repo-provisioning.ts`: `GET /v1/projects/repo-authorize-url` +
  `POST /v1/projects/create-repo`, both `requireAuth`, wired via a new
  `repoProvisioning?` BuildAppOptions dep (app.ts + server.ts).
- **New REQUIRED env: `GITHUB_APP_CLIENT_ID` + `GITHUB_APP_CLIENT_SECRET`** (the App's
  OAuth creds, DISTINCT from `GITHUB_APP_PRIVATE_KEY`). `GITHUB_OAUTH_BASE_URL` already
  existed. env.test.ts `validEnv()` carries both.

**github-stub already had all the GitHub-side routes** (`/login/oauth/access_token`
→ `ghu_stub_user_N`, `/user/repos` → `acme/<name>` requiring a `ghu_` token,
`PUT .../repositories/:id` → 204). **GOTCHA: the github-stub has NO reset/introspection
route** (only `POST /__admin/contents`) and accumulates state across a shared
container — so the API e2e asserts through the API's OWN effects (201 body, created
Project row `repoOwner:"acme"`, job status) with UNIQUE stamped repo names, NEVER stub
counters. API e2e `tests/e2e/repo-provisioning.e2e.ts` ran IN-PROCESS (buildApp +
listen + real fetch + the task-18 stand-in scaffold worker) per
[[in-flight-dblib-e2e-constraint]] — 5/5 green against the real stub.

**nextjs — the browser JIT flow = popup + cross-tab localStorage handoff, NOT a
full-page redirect** (a redirect resets wizard step-state; this mirrors OpenRouter's
verifier stash). New pure effect module `lib/project-wizard/provision-effects.ts`:
`stashCreateRepoParams(state,…,storage)` → `window.open('/api/connect/github/create-repo/
start?state=<nonce>')` (popup) → the CLIENT callback page
`app/connect/github/create-repo/callback/page.tsx` reads the stash + `?code`, `POST
/api/projects/create-repo`, `writeCreateRepoResult` under the nonce, `data-state=done` →
the main tab `pollCreateRepoResult(nonce)` picks it up → `pollJobUntilTerminal` drives
the log. Also `scaffoldExistingRepo`/`importRepo` (POST → `{projectId,jobId}`) +
`fetchJob`. BFF routes (thin `forwardToApi`): `app/api/projects/route.ts` (GET list +
POST create), `/import`, `/create-repo`, `/[id]/jobs/[jobId]`, and
`/api/connect/github/create-repo/start` (302 → authorize URL).

**Provisioning-log data-source SWAP (view contract preserved).**
`lib/project-wizard/job-log.ts`: `stagesToLogRows(stages)` (done→completed,
running→active, pending→queued, failed→failed) + `logSequenceToRows(seq)` (the mock
ticker adapter) + `jobSucceeded/jobFailed/jobIsTerminal/failedStageKey`. The
`ProvisioningLog` component now takes `rows: LogRow[]` (added a `failed` ✕ visual);
`data-testid="log-row"` + `data-status` UNCHANGED. Both wizards render
`rows={isMock ? logSequenceToRows(log) : realRows}`.

**MOCK MODE PRESERVED (hard invariant, tasks 24/25 rule).** Both wizards branch on a
NEW `isMock` field exposed from the session context (`mounted && parseMockSession(...)`).
Mock → fake ticker + `MOCK_REPOS` + hardcoded ids (the mock `project-wizards.e2e.ts`
stays 6/6 green untouched). Real/seed → real endpoints + real repos
(`fetchWizardRepos(filter)` maps `GithubRepo`→`MockRepo` shape) + polled stages. Import
"NOT A SUPAGLOO PROJECT" card is driven by the real `verifySupaglooProject` stage
failing (job.status failed), not the mock `isSupaglooProject` flag.

**Grid + landing + copy.** `lib/workspace/projects-real.ts` (`fetchProjectCards` →
`GET /api/projects` → `ProjectDto[]`→card, card id = SLUG for `/studio/<slug>`);
`workspace-home` fetches in real mode + passes `projects` prop to `RecentProjects`
(mock mode → DEMO_PROJECTS fallback). Landing (fabulous-tech-lead slice): votd/passage
(`start-cards.tsx`) + demo (`featured-demo.tsx`) render DISABLED "Coming soon"
(`data-disabled="true"`, testids `start-card-votd/passage`, `start-demo`); Blank canvas
= `<a href="/?newproject=blank">` which `workspace-home` honors to auto-open the New
wizard. §9-Q4 honest copy in `recent-projects.tsx`: "Your Remotion code lives in your
GitHub repo, not our database.* / * Rendered videos are stored in Supagloo's S3 bucket."
(replaced "Nothing is stored on our servers."; `workspace-profile.e2e.ts:218` anchor
updated). `lib/landing/start-cards-model.ts` is the pure disabled/enabled model.

**Real-stack Stagehand spec `tests/e2e/project-wizards-real.e2e.ts` WRITTEN, execution
DEFERRED** to the release/submodule-bump step per [[in-flight-dblib-e2e-constraint]]
(the new db-lib schemas + a running DBOS git-ops worker are needed for the
containerized full stack). New helper `completeCreateRepoViaCallback(page,context)`
reads the wizard's stashed nonce out of localStorage then drives the JIT callback URL
(mirrors `completeGithubConnectViaCallback`). Behavior proven meanwhile by: the API
in-process JIT e2e + the nextjs unit suite + the mock `project-wizards.e2e.ts`.

**Final green:** db-lib 269 unit; api JIT unit (user-auth client + repo-provisioning
service + env = 39) + full unit green EXCEPT the pre-existing
`dockerfile-database-lib-pin` guardrail (expected in-flight — I touched neither the
Dockerfile nor the submodule pin) + repo-provisioning e2e 5/5; nextjs 298 unit + tsc
clean + mock project-wizards e2e 6/6 + workspace-profile/onboarding/landing/
landing-start-cards e2e 34. Studio landing after this task still uses the mocked
`findStudioProject`/`DEMO_STORYBOARD` seam (real hydration is task 27).
