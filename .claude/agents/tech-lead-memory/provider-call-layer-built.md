---
name: provider-call-layer-built
description: Task 29 (OPENS M5) built supagloo-nodejs-dbos src/providers/ — the reusable step-helper library (credential decrypt, generateObject wrapper, media client, discovery) that #30/#32/#33/#34 wrap in DBOS steps
metadata:
  type: convention
---

Built 2026-07-21 (plan task 29) — **opens Milestone M5**. TDD plan:
`supagloo/scratch/task-29-dbos-provider-call-layer.md`. A **reusable step-helper
library** in `supagloo-nodejs-dbos/src/providers/`, NOT a workflow — zero
`DBOS.registerWorkflow`, no registry entry. #30/#32/#33/#34 wrap these pure helpers
in `DBOS.runStep`. Its "e2e" is integration-style: helpers called DIRECTLY against
the openrouter/gloo stub containers, no DBOS launch/enqueue (crash-replay belongs to
the workflows on top). Depends on [[nodejs-dbos-bootstrap]], [[provider-stub-harness]],
[[openrouter-gloo-connections-built]], [[openrouter-media-and-ai-sdk-split]].

**File split (`src/providers/`, mirrors the scaffold-project/ precedent):**
`config.ts` (ProviderConfig singleton set/get/clear) · `errors.ts` (typed errors +
retry classifier + retry-option consts) · `credentials.ts` · `gloo.ts` (token mint) ·
`generate-object.ts` (buildStructuredModel + callLlmStructured) · `discovery.ts` ·
`media-client.ts` · `index.ts` barrel. Helpers are PURE (explicit args + injectable
`fetch`/`prisma`/clock); the `ProviderConfig` singleton is what workflows read to get
those args (injected in `runtime.ts` `launchDbos` via `setProviderConfig`, cleared in
`shutdownDbos` — same discipline as `setAppDb`/`setScaffoldConfig`).

**AI SDK: `ai@^5.0.218` + `@ai-sdk/openai@^2.0.114`** (the exact pair
supagloo-nextjs proves works; NEW deps in dbos). BOTH providers use
`createOpenAI({ baseURL, apiKey, fetch }).chat(modelId)` — `.chat()` defaults
`structuredOutputs:true` → emits `response_format:{type:"json_schema"}`, the shape
BOTH stubs key on. Provider→surface: **openrouter `{base}/api/v1`** → hits
`/api/v1/chat/completions`; **gloo `{base}/ai/v2`** → hits `/ai/v2/chat/completions`.
NOT the bare `openai(id)`/Responses path (Gloo ignores structured output there —
verified in nextjs CLAUDE.md). `callLlmStructured` passes **`maxRetries:0`** so the
AI SDK does NO internal retry — the DBOS step owns retry (single source of truth).

**Retry classifier (`errors.ts`, verified empirically against the installed SDK):**
`retryUnlessPermanent(e)` = `!isPermanentProviderFailure`. Permanent (→ NO step
retry): `NoObjectGeneratedError.isInstance(e)` (schema-validation failure — surfaces
to the workflow's bounded REPAIR loop §6d, NOT step-retried), a permanent 4xx
(4xx-except-429) from our `ProviderHttpError.status` OR the AI SDK's
`APICallError.statusCode` (with `maxRetries:0` a 5xx surfaces as `APICallError`
statusCode 503, NOT a wrapped `RetryError`), and the typed `*NotConnectedError`s.
Transient (→ retry w/ backoff): 5xx, 429, unknown (default). Exported step-option
consts spread into `DBOS.runStep`: `LLM_STRUCTURED_RETRY` (**maxAttempts:5** + backoff,
design-mandated), `MEDIA_RETRY`, `DISCOVERY_RETRY` (each bundles `shouldRetry`).

**Credentials** reuse db-lib `decryptSecret` (never reimpl): `loadOpenRouterCredential`
/`loadGlooCredential({prisma,userId,encryptionKey})` → findUnique the connection row →
decrypt `apiKeyCiphertext`/`clientSecretCiphertext`. Null row → typed
`OpenRouter/GlooNotConnectedError`. Unit-tested with real crypto + a fake prisma cast
to `PrismaClient` (no DB e2e — the task scopes decrypt to a unit test).

**Gloo token** (`mintGlooToken`): `POST {glooBase}/oauth2/token`, Basic `id:secret`,
form `grant_type=client_credentials&scope=api/access` → `{accessToken,…}`. Minted
FRESH per run, never persisted. **NOTE the api-side `gloo-client.ts` omits the
`scope=api/access`** (it only verifies); the dbos client includes it (it actually USES
the token) — matches nextjs `lib/gloo/llm-client.ts`.

**Discovery** (`discoverModels({outputModalities})` → `/api/v1/models?output_modalities=csv`;
`discoverVideoModels()` → `/api/v1/videos/models`) parses `data[].id`. Process-level
**TTL cache** (module-level Map keyed by baseUrl+modalities, injectable `now`/`ttlMs`,
`clearDiscoveryCache()` to reset). Modality tokens (`"text"`,`"audio"`) are provider
QUERY values, not model ids. **Gloo model discovery is a DIFFERENT endpoint
(`/platform/v2/models`) — out of scope here** (#30 if needed).

**Media client** (direct `fetch`, NOT AI SDK): `requestSpeech` (raw `audio/mpeg`
bytes + `x-generation-id`, no JSON parse) · `submitVideoJob` (202, sends
`Idempotency-Key`) · `getVideoJob(pollingUrl)` · `getVideoContentUrls(id)` ·
`downloadBytes(url)`. Durable polling ORCHESTRATION (30s sleeps, persist-jobId-in-
submit-step) is #34's, NOT here.

**"No hardcoded model ids" lint** (`no-model-ids.test.ts`): scans `src/providers/*.ts`
(minus `*.test.ts`) for model-id-shaped literals (`vendor/model`, `gloo-<vendor>-…`,
`stub/(text|speech|video)-model`, `gpt-N`, `claude-…N`, `gemini-N`) → must be zero.
GOTCHA: the gloo pattern is **vendor-qualified** (`gloo-(openai|anthropic|…)-`) so a
prose ref like `gloo-connections-built` doesn't false-positive.

**Two judgment calls that edited the ROOT canonical `tests/stubs/` (allowed — root's
own dir, not a submodule copy):**
1. **Gloo chat path discrepancy RESOLVED to the real slash path.** The stub served
   `/ai/v2/chat-completions` (hyphenated, a task-9 simplification consumed by nothing
   real); the AI SDK hard-codes the `/chat/completions` suffix and real Gloo IS slash.
   Changed the stub to `POST /ai/v2/chat/completions` + made it `response_format`-aware
   (json_schema → `{stub:true}` JSON, else prose), updated the 2 root tests
   (`stub-gloo.test.ts`, `stub-gloo.e2e.ts`). ONE code path now works for stub AND prod.
2. **OpenRouter discovery filtering ADDED.** Stub `/api/v1/models` now tags each model
   `output_modalities` (`stub/text-model`=`["text"]`, `stub/speech-model`=`["audio"]`)
   and filters by the query param (real OpenRouter does; makes the e2e assertion
   meaningful). Non-breaking; added a root unit assertion.

**`SECRETS_ENCRYPTION_KEY` is now REQUIRED in dbos env** (copied verbatim from api:
`OPENROUTER_BASE_URL`/`GLOO_BASE_URL` provider-URL defaults + the 64-hex key). Making
it required rippled into all 5 existing e2e `loadEnv({...})` blocks + `env.test.ts`'s
`validEnv()` (added a dummy `"0".repeat(64)`). Root compose `dbos` service env left
as-is (already omits the task-17 `GITHUB_APP_*` — containerized dbos boot deferred to
task 46).

**e2e** (`tests/e2e/providers.e2e.ts`, integration-style, no DBOS launch): OpenRouter
+ Gloo `generateObject` round-trip (schema `z.object({stub:z.boolean()})` — the stub
always returns `{stub:true}` for json_schema); Gloo token minted-per-run (2 mints →
distinct tokens, `tokensIssued===2`); discovery filter (text→text-model, audio→
speech-model, video-models); media (TTS bytes, video submit→poll→content→download,
idempotent submit: `byRoute["POST /api/v1/videos"]===2` but `state.videoJobsCreated===1`).
`global-setup.ts` extended: spawn+probe openrouter-stub(:4802)/gloo-stub(:4803) with
**staleness probes** (openrouter: text query returns exactly 1 id; gloo: slash path
401s not 404s) so a reused pre-task-29 image is rebuilt.

**Final green:** dbos **192 unit** (+45) + typecheck clean + **18 e2e** (6 files, incl.
7 new providers e2e); root **74 unit** (stub tests green). **Pre-existing RED (NOT
ours):** `src/dockerfile-database-lib-pin.test.ts` (the in-flight ARG↔submodule drift,
see [[in-flight-dblib-e2e-constraint]]). The ROOT **containerized** `stub-gloo.e2e.ts`
can't run — its global-setup needs the full stack incl. the `api` container, which is
the in-flight-db-lib-deferred path (fails at setup, not from our change; the slash-path
change is proven via curl + the dbos providers e2e hitting the real container + the
root unit test).
