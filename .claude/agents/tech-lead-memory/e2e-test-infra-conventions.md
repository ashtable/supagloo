---
name: e2e-test-infra-conventions
description: Plan-level e2e conventions (docs/plan.md) — real-provider gating e2e for ALL FOUR providers incl. GitHub (stubs fully deleted 2026-07-25, design-delta §11); flag-gated /v1/test/seed built early; Stagehand real-stack mode via seed, three nextjs lanes; DBOS crash/replay proven by system-DB step counts + real-host artifact reads
metadata:
  type: convention
---

Established 2026-07-17 in `docs/plan.md` (Step 5 of `/design`), pending user
approval of that plan:

- **THERE ARE NO STUBS. e2e is real for all four providers.** (Current as of
  2026-07-25.) Every outbound base URL still defaults to the real host in both
  backend env loaders, and **nothing overrides them** — real-by-default is
  achieved by not overriding. `tests/stubs/**` is DELETED in full.
  History, so the older notes read correctly: task 9 built five stub HTTP
  servers + a local git smart-HTTP server with `/__stub/calls` call-count
  assertions; task 34-E8 (design-delta §10) deleted the
  openrouter/gloo/youversion three; **task 62 (design-delta §11) deleted the
  last two — `github-stub` and `git-server` — plus the whole directory.**
  Failure injection (503/repair/timing, and now 401/404/422/405/409/429) lives
  in injected-fetch **unit** tests; required real secrets come from the root
  `.env` and **throw** in e2e setup when missing (never warn-and-skip — vitest's
  default reporter hides skipped-file console output; row 56 item 2).
  Sole exception: interactive browser logins — a spec may shim only that hop
  (YouVersion OAuth, OpenRouter's PKCE page, and GitHub's create-new-repo token
  exchange, where the shim is one injected `fetchImpl` that throws on any URL
  other than `POST /login/oauth/access_token`).
  **Do not re-add a stub, a `/__stub/*` call, or a `GITHUB_*_BASE_URL` override.**
  Permanent unit guards fail you, and §10.7/§10.9/§11.7 forbid it by policy.
  Today's GitHub harness: [[real-github-e2e-harness]].
- **`POST /v1/test/seed`** (flag-gated, `NODE_ENV !== 'production'`, per
  design-delta §9-Q9) is built *early* (M2, with auth) because nearly all
  later e2e depends on deterministic users/sessions — deliberately not left
  to end-stage hardening.
- **Stagehand real-stack mode**: the existing `NEXT_PUBLIC_SUPAGLOO_DEMO`
  mock-session seam is extended so flag-gated test sessions obtain a *real*
  session cookie via the seed endpoint — UI e2e then exercises
  browser → BFF → API → Postgres/MinIO/DBOS for real. Old mock-session-only
  specs are kept for pure-UI regressions. Stagehand is the UI e2e tool;
  non-UI e2e never uses a browser.
- **DBOS crash/replay tests are standard** for workflows where the design
  emphasizes recovery: kill/cancel the worker mid-workflow, resume, assert
  completed steps don't re-execute and side effects aren't duplicated.
  **The proof is TWO axes now, never a stub counter** (design-delta §10.5/§11.5):
  (1) **durability** = `countStepExecutions` over the DBOS system DB — one
  `StepInfo` row per `functionID`, so neither an internal retry nor a replayed
  resume inflates it; (2) **non-duplication** = a real-host artifact read.
  GitHub has both axes (exactly one merged PR, one `refs/tags/v<semver>`, an
  unchanged commit count); OpenRouter has only (1) plus `providerJobId`
  stability, because it offers no introspection (§10.5 accepted risk);
  `importProject` has only (1) because it is read-only.
  **Reading rule, and it is a bug class:** artifact reads ALWAYS pass
  `state: "all"`. A merged PR is `closed`, so `state=open` reports zero PRs for
  a successfully scaffolded repo — a green lie. The same mistake existed in the
  product (`findOpenPrByHead`) and was fixed in task 62.
- **Slow render e2e** (real `@remotion/renderer`) runs in a separate heavy
  lane, not on every push; the never-merge-red rule still applies to the lane.
  Both dbos (`test:e2e:render`) and nextjs (`test:e2e:render`) have one.
- **nextjs has THREE e2e lanes** (task 62): `test:e2e` (mock — Docker-free, no
  secrets, no network, and the ONLY lane that must not load root's `.env`),
  `test:e2e:real`, `test:e2e:render`. `tests/unit/e2e-lane-coverage.test.ts`
  asserts every `tests/e2e/*.e2e.ts` belongs to exactly one lane — a spec in no
  lane never reports, which is a green-lie generator. NOTE the mock lane is
  currently **flaky** (`studio-project.e2e.ts`, ~50%, plan row 68): a single
  green run there is weak evidence.
- **Root `.env` must reach the WORKERS, not just globalSetup.** vitest runs
  `globalSetup` in the main process and specs in worker processes, so env set in
  globalSetup does not reach a spec. Each real lane has a `setupFiles` entry
  that calls `process.loadEnvFile` on root's `.env` (it does not override an
  already-set var, so an explicit `FOO=… npm run test:e2e` still wins).
- **HISTORICAL (all resolved; kept because 34-E*/62's rows reference it) — stub coupling ran deeper than base URLs** (verified 2026-07-22 against
  the code; **docs closed the gap 2026-07-23** — design-delta §10.7 now names
  this "third coupling category" and plan 34-E3/E4/E8 carry the sub-steps):
  the e2e **bodies** depend on stub-only constructs that do NOT exist on real
  hosts — (1) `/__stub/calls` call-count assertions (`stubState`/`stubCalls`:
  `chatCompletions`, `tokensIssued`, `videoJobsCreated`) in
  `providers.e2e.ts`, all four `generate-*.e2e.ts`, and api
  `connections.e2e.ts` (OpenRouter-credits + Gloo-verify — this api file, NOT
  dbos `providers.e2e.ts`, is where the credits/verify rework lives; 34-E3's
  original text had them mixed up); (2) `/__stub/reset`; and
  (3) `/__admin/chat-script` + `/__admin/speech-script` response
  **programming** in `generate-script.e2e.ts`/`generate-audio.e2e.ts` — dbos
  `global-setup.ts`'s `/__admin/*-script` calls are stub-image *staleness
  probes*, not programming (die with the stub wiring, no replacement).
  Dispositions decided 2026-07-23: **`providers.e2e.ts` = rework, not delete**
  (in 34-E8: only spec exercising real Gloo `.chat()` at the primitive level +
  hosts the no-stub guard; chat/discovery flip to real hosts with structural
  assertions; media-client section incl. the Idempotency-Key double-submit
  test deleted — provider-introspection-only, §10.5 accepted risk).
  `generate-script.e2e.ts`'s own crash/replay test is homed in **34-E4**
  (park→cancel→resume vs real host; proof = system-DB LLM-step-execution
  count unchanged across resume + schema-valid result; 34-E4 introduces the
  shared step-introspection helper 34-E7 reuses).
  `generate-video.e2e.ts`'s ordinary happy-path test (distinct from 34-E7's
  crash/replay) swaps `videoJobsCreated`/`FAKE_MP4`/`vid_`-prefix assertions
  for a system-DB single-submit check + structural asset/id assertions.
  DBOS v4.23.6 exposes `DBOS.listWorkflowSteps(workflowID)` (StepInfo with
  `name`=function_name) for the §10.5 exactly-once step-count proof.
  `generateScriptWorkflow` supports **both** `openrouter` and `gloo`, but no
  dbos e2e currently exercises `provider: "gloo"` (only `providers.e2e.ts`
  covers real Gloo `.chat()` — the reason it survives).

Resolved sign-off item from plan §6: `mintInstallationToken` lives in
`database-lib` (shared), not duplicated per service. See
[[github-app-installation-tokens]] and [[github-app-pem-normalization]].

## A RUNNING `supagloo-dbos-1` USED TO SILENTLY FAIL THREE api e2e FILES — **FIXED 2026-07-26**

**Do not chase this any more, and never "fix" it by stopping the container.** See
[[dbos-e2e-lane-schema-isolation]] for the mechanism that closed it. History kept because the
symptom table is still the fastest way to recognise a *regression* of the fix.

Diagnosed and fixed the same day. The api e2e lane's DBOS-touching specs register an **in-process
stand-in workflow under the real shared workflow name on the real queue**, and used to assume an
idle Compose `dbos` service. Two things were wrong with that assumption: it was **unsatisfiable**
across a full sweep (root's own e2e lane and nextjs's render lane both bring `dbos` up on purpose),
and `project-jobs.e2e.ts`'s stated justification for it — that global-setup did not start the
service — was **false at the time it was written** (root `tests/e2e/global-setup.ts` starts `dbos`).
A running container is a **competing consumer**: it grabs the enqueued workflow first, runs the REAL
workflow against fixtures never provisioned for it, and fails it. The stand-in never sees the work.

Symptom table — now the signature of a REGRESSION of the schema-isolation fix, not of an
un-stopped container:

| Spec | Visible failure | Container log |
|---|---|---|
| `renders.e2e.ts` | `render <id> did not reach completed within 25000ms (last=failed)` | `RenderRequestInvalidError: project owner … has no GitHub installation — cannot clone`; `installation token exchange failed for installation 42: 404` |
| `ai-generations.e2e.ts` | same poll timeout, `last=failed` | `OpenRouterNotConnectedError: no OpenRouter connection for user …` |
| `project-jobs.e2e.ts` | flaky poll timeout | same family |

If you see that table today, the lane's `systemDatabaseSchemaName` wiring has been dropped — and
the `assert*` probes should have caught it first and named the remedy.
