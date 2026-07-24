---
name: task-34-e8-harness-simplification
description: 34-E8 deleted the three provider stubs (openrouter/gloo/youversion) + all wiring across root/api/dbos, reworked providers.e2e to real hosts, and discovered Gloo's live model-catalogue endpoint
metadata:
  type: decision
---

Task 34-E8 (design-delta §10.7/§10.8) done 2026-07-23. The LAST stub-teardown task: with
34-E1..E7 having migrated every real-provider path, the openrouter/gloo/youversion stubs were
dead infra, so this task DELETED them across all three repos. `github-stub` + `git-server`
untouched — the shared `STUB_KIND` image now serves **2 kinds instead of 5** (verified: rebuilt
image + `stub-github.e2e`/`git-server.e2e` still green). Plan:
`scratch/task-34-e8-harness-simplification.md`. Supersedes the 5-stub world in
[[provider-stub-harness]].

**What was deleted (root repo):** `docker-compose.test.yml` — the 3 stub service blocks + the
`api` service's `OPENROUTER_BASE_URL`/`GLOO_BASE_URL`/`YOUVERSION_BASE_URL` overrides (GitHub
overrides stay). `tests/stubs/src/{openrouter,gloo,youversion}-stub.ts` + `fixtures/kjv-bsb.ts` +
their 3 `main.ts` switch cases (now `github|git` only). `tests/{unit,e2e}/stub-{openrouter,gloo,
youversion}.*`. `PROVIDERS.{openrouter,gloo,youversion}BaseUrl` in `tests/support/dev-config.ts`
(orphaned once the self-tests went). Root `tests/e2e/global-setup.ts` `INFRA_SERVICES` +
`stubsReady()` drop the 3 (keep github + git-server). `compose-test-overlay.test.ts` reworked to
ASSERT the 3 services + the 3 api overrides are gone (github/git survive).

**KEY DECISION — the global-setup "fail-fast" question (the crux judgment call).** The task
prose + §10.8 say "both backend repos' global-setup should fail fast on missing secrets," and the
34-E3 memory predicted "34-E8 adds its own global-setup fail-fast." I did NOT add a blanket
provider-secret check to either shared `global-setup.ts`. Reason: the §10.8 "fail, don't skip"
property is ALREADY guaranteed, correctly SCOPED, by the per-spec `resolveConnectionSeedCreds`
(api) / `resolveGenerationSeedCreds` (dbos) called in each real-provider spec's `beforeAll` (they
THROW naming the missing var — those unit tests already cover "each var missing → names it; all
present → proceeds", the plan.md deliverable). A blanket check in the SHARED global-setup would
over-couple the MANY non-provider e2e specs (api: projects/files/manifest/github-connection/…;
dbos: noop/scaffold/commit/publish/import/…) to provider secrets they never use — global-setup
runs once for the whole run and can't tell which specs are selected. So 34-E8's "its own
fail-fast" is delivered by the **reworked `providers.e2e.ts` beforeAll** calling
`resolveGenerationSeedCreds()` — a spec-level fail-fast, consistent with E3/E4. Both global-setups'
change is PURELY stub teardown.

**Gloo HAS a live model catalogue (corrects [[task-34-e4-dbos-e2e-real-provider-generate]]'s "no
Gloo discovery").** 34-E4 said a live Gloo generation would need a hardcoded id because
`discoverModels` hits OpenRouter only. But Gloo exposes its OWN authenticated catalogue:
`GET {GLOO_BASE_URL}/platform/v2/models` (bearer token, `data`/`models` array, ids namespaced like
`gloo-openai-gpt-5-mini`) — documented in supagloo-nextjs/CLAUDE.md, **verified LIVE** here. New
TEST-ONLY helpers in dbos `src/testing/e2e-models.ts` (dist-excluded): `toGlooModelInfo`,
`selectGlooChatModel` (prefer cheap-tier id mini/nano/small/lite/flash/haiku, else first, throw on
empty), `resolveGlooModel(env, bearerToken)`. Note the catalogue path prefix is `/platform/v2`,
NOT the `/ai/v2` chat surface. NOT added to production `src/providers/discovery.ts` (the app's
generation is OpenRouter-only; this is e2e-only infra).

**`providers.e2e.ts` reworked (dbos, §10.7 "rework not delete").** The only spec exercising real
Gloo `.chat()` at the provider-primitive level. Now: (1) inverted `beforeAll` → a **no-stub
guard** — `it.each` over the 3 base URLs asserting `^https://` and NOT `localhost|127.0.0.1|-stub|
:480\d` (guards both host-port and compose-internal stub forms; VERIFIED it goes RED when a stub
URL is injected). (2) OpenRouter + Gloo chat round-trips flipped to real hosts with run-time
discovery-resolved model ids (`resolveTextModel` / `resolveGlooModel`) + structural schema-valid
assertions (`z.object({greeting: z.string().min(1)})` — no `stub/*` literals). (3) discovery
assertions → non-empty catalogues (text/audio/video). (4) DELETED the whole media-client
primitives section (speech/video + the `Idempotency-Key` double-submit test — §10.5
provider-introspection-only, duplicative of 34-E4/E7) + `resetStub`/`stubState`/`stubCalls`.
**Ran GREEN live (8/8) against real OpenRouter + Gloo.**

**dbos global-setup:** removed the 3 stub-URL constants, `openRouterStubReady`/`glooStubReady`/
`youversionStubReady` + orphaned `stubHealthy`, and — per §10.7's explicit nuance — the
`/__admin/chat-script` + `/__admin/speech-script` staleness probes (they are stub-image staleness
probes, not response programming — deleted with the wiring, no replacement). generate-script.e2e
still green under it (live YouVersion passage path, no youversion-stub).

**api (judgment call, beyond the literally-named `auth.e2e.ts`):** 8 specs (connections, files,
project-jobs, repo-provisioning, projects, manifest, github-connection, ai-generations) each built
a **never-invoked** `makeYouVersionVerifier` with a `YOUVERSION_STUB_URL ?? localhost:4804`
fallback (sessions come from `/v1/test/seed`). Repointed to the real-host idiom
`YOUVERSION_BASE_URL ?? "https://api.youversion.com"` (zero egress; matches the OpenRouter/Gloo
idiom already in those files) — §10.7 "remove hardcoded stub-URL fallbacks / guard against creep."
api global-setup dropped the 3 stubs (keeps postgres/github-stub/minio). No new secret check.

**Honest comment fixes (production src, comment-only, zero behavior):** api + dbos `config/env.ts`
and dbos `dbos/runtime.ts` had comments claiming "the test overlay overrides these base URLs to
the stubs" — now false, corrected.

**Deliberate LEAVE-ALONE (documented, not scope):** unit-test fixture strings that use
stub-flavored URLs as arbitrary injected-fetch inputs (api `env.test.ts` override test,
`auth/youversion.test.ts` URL-construction) and api `ai-generations.e2e.ts`'s `stub/*` **model-id
input** fixtures (task 31 CRUD spec; the api never resolves them against a provider). Not stub
infra, not URL fallbacks, not catalogue assertions.

**Verification (2026-07-23):** unit green all 3 repos (root 53, api 330, dbos 350) + api/dbos
typecheck clean. Live e2e: dbos providers 8/8, generate-script 3/3, noop 2/2; api full suite 61
pass + 1 loud-skip (auth-live, the §10.8 YOUVERSION_E2E_ACCESS_TOKEN exception); root
stub-github+git-server self-tests 5/5 on the rebuilt image. NOT run (env-limited): full root
Compose e2e (builds api/migrate container images — heavy, and its infra coverage is unaffected by
stub deletion) and dbos generate-{image,audio,video} (paid, §10.9 cost-gated; video $0.50/clip).

See [[task-34-e4-dbos-e2e-real-provider-generate]], [[task-34-e5-youversion-real-api]],
[[task-34-e6-youversion-signin-e2e-rework]], [[api-e2e-real-provider-connection-seeding]],
[[e2e-secrets-gloo-naming-collision]], [[provider-stub-harness]].
