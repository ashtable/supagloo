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
  the code — matters for the §10 real-provider migration): the e2e **bodies**
  depend on stub-only constructs that do NOT exist on real hosts —
  (1) `/__stub/calls` call-count assertions (`stubState`/`stubCalls`:
  `chatCompletions`, `tokensIssued`, `videoJobsCreated`) in
  `providers.e2e.ts`, `generate-video.e2e.ts` (incl. its cancel/resume tests,
  not only crash/replay), and api `connections.e2e.ts` (OpenRouter-credits +
  Gloo-verify); (2) `/__stub/reset`; and (3) `/__admin/chat-script` +
  `/__admin/speech-script` deterministic-response **programming** for HAPPY
  paths — in `generate-script.e2e.ts` and, crucially, in dbos
  `tests/e2e/global-setup.ts` (~lines 145-166). Flipping specs to real hosts
  requires reworking these bodies (delete `/__admin/*` programming, convert
  exact-content assertions to schema-valid/structural, replace `/__stub/calls`
  counters with DBOS system-DB introspection or drop them) — not just swapping
  URLs. DBOS v4.23.6 exposes `DBOS.listWorkflowSteps(workflowID)` (StepInfo
  with `name`=function_name) for the §10.5 exactly-once step-count proof.
  `generateScriptWorkflow` supports **both** `openrouter` and `gloo` providers,
  but no dbos e2e currently exercises `provider: "gloo"` (only
  `providers.e2e.ts` covers real Gloo `.chat()` at the primitive level).

Open sign-off item recorded in plan §6: whether `mintInstallationToken`
lives in `database-lib` (shared, recommended) or is duplicated per service
(as the design text reads). See [[github-app-installation-tokens]].
