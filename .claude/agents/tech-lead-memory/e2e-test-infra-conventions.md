---
name: e2e-test-infra-conventions
description: Plan-level e2e conventions (2026-07-17, docs/plan.md; provider-stub posture superseded 2026-07-22 for OpenRouter/Gloo/YouVersion by design-delta §10) — real-provider gating e2e for those three, GitHub still stubbed; flag-gated /v1/test/seed built early; Stagehand real-stack mode via seed; DBOS crash/replay tests standard
metadata:
  type: convention
---

Established 2026-07-17 in `docs/plan.md` (Step 5 of `/design`), pending user
approval of that plan:

- **Provider-stub harness** (plan task 9): all outbound provider base URLs
  (GitHub API, OpenRouter, Gloo, YouVersion) are env-overridable; e2e points
  them at stub HTTP servers with call-count assertions, plus a **local git
  smart-HTTP server** so clone/push/PR-merge flows in git-ops workflows run
  against real git. Stubs never ship in production images.
  **SUPERSEDED 2026-07-22 for OpenRouter/Gloo/YouVersion** (design-delta §10,
  signed off; plan tasks 34-E1–34-E8): e2e for those three always hits the
  **real provider APIs** and *is* the gating suite — the three stubs get
  deleted; failure injection (503/repair/timing) moves to injected-fetch
  unit tests; real secrets from `.env` fail e2e setup fast when missing.
  **GitHub stays stubbed** (github-stub + git-server untouched, out of scope).
  Sole exception: interactive browser logins (YouVersion OAuth, OpenRouter
  PKCE page) — UI specs may shim only that hop.
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
  emphasizes recovery: kill the worker mid-workflow, restart, assert
  completed steps don't re-execute and side effects aren't duplicated
  (flagship case: `generateVideoClipWorkflow` — stub submit count stays 1
  across a crash between submit and poll-completion).
- **Slow render e2e** (real `@remotion/renderer`) runs in a tagged heavy
  lane, not on every push; the never-merge-red rule still applies to the lane.
- **Stub coupling runs deeper than base URLs** (verified 2026-07-22 against
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

Open sign-off item recorded in plan §6: whether `mintInstallationToken`
lives in `database-lib` (shared, recommended) or is duplicated per service
(as the design text reads). See [[github-app-installation-tokens]].
