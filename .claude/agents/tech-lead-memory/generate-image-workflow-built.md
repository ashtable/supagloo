---
name: generate-image-workflow-built
description: Task 32 built generateImageWorkflow — the FIRST media-generation workflow and the FIRST real S3 WRITE in the codebase; establishes the callImageModel→fetch+upload pattern #33 (audio) / #34 (video) reuse, plus the dbos internal-role S3 client + S3 env/config
metadata:
  type: reference
---

Built 2026-07-22 (plan task 32, M5). Plan: `supagloo/scratch/task-32-generate-image-workflow.md`.
Design authority: design-delta §7 workflow 6. Depends on [[generate-script-workflow-built]]
(the workflow template), [[provider-call-layer-built]] (media client), [[ai-generation-api-built]]
(the API surface it un-501s), [[s3-file-presign-service-built]] (the reader side + the shared
key layout), [[in-flight-dblib-e2e-constraint]] (the release sequence). All GREEN against the
released, submodule-pinned db-lib (`c1938fd`).

**Shape.** `src/workflows/generate-image.ts` registers `generateImage` (queue `ai-generation`).
`image` is openrouter-ONLY (§9-Q2). `workflowID === AiGeneration.id`; payload is the minimal
`{generationId}` echo (`GenerateImagePayload`). **NO repair loop** (unlike generateScript — image
output is opaque bytes, not schema-validated JSON). Steps: `loadRequestAndCredentials` (validate
kind=image + projectId present + input; verify OpenRouter connection EXISTS w/o returning the
secret; queued→running) → `callImageModel` → `uploadAssetToS3` → `persistResult`. Helpers in
`src/workflows/generate-image/`: `errors.ts` (`GenerationRequestInvalidError` +
`isPermanentGenerationFailure`/`retryUnlessPermanentGeneration`), `request.ts`
(pure `parseImageRequest(row)`), `finalize.ts` (running/persist/failed writes). Only writes the
`AiGeneration` row (status + `resultAssetKey`; `resultJson` stays null — the ASSET is the result).
Failure path mirrors generateScript: outer try/catch → `recordFailure` only on
`isPermanentGenerationFailure`; transient + DBOS-cancellation propagate.

**KEY judgment call — `fetchAssetBytes` + `uploadAssetToS3` are ONE DBOS step (not two).** The
design names them as two steps, but implementing two separate DBOS steps is wrong here: (1) a
step's return value is CHECKPOINTED, and image bytes (MBs; a Buffer JSON-serializes ~10x) must
never bloat the DBOS system DB; (2) a workspace-temp-file handoff between two checkpointed steps
is NOT crash-safe (on replay the checkpointed fetch step returns without re-writing the file, so
upload finds no bytes). So `callImageModel` is its own step returning the small checkpoint-safe
`{ imageUrl }` (a content URL, not a secret — like video's `unsigned_urls`); `fetchAssetBytes` +
upload are folded into ONE `uploadAssetToS3` step (bytes stay in step-local memory, returns just
`{ assetKey }`), atomically retryable against the deterministic idempotent key. `fetchAssetBytes`
survives as a named, unit-tested media-client helper invoked inside the step. **This is THE
precedent #33 (audio bytes) / #34 (video bytes) must reuse.**

**Resolved open decisions (all documented in the plan):**
- **Retry** = `MEDIA_RETRY` (task-29's reserved-but-unused `maxAttempts:4` media const) for
  `callImageModel` + `uploadAssetToS3`, NOT `LLM_STRUCTURED_RETRY` (5). "retries as above" is
  satisfied in SHAPE (retriesAllowed + expo backoff + shouldRetry-rejects-4xx); image is a media
  kind so it shares the media const with #33/#34. `loadRequestAndCredentials` = `DISCOVERY_RETRY`
  (3); persist/recordFailure = `{retriesAllowed, maxAttempts:3}`. Every step's `shouldRetry` is the
  generation-scoped `retryUnlessPermanentGeneration`.
- **OpenRouter image contract** (design does NOT pin it) = OpenAI-Images-compatible
  `POST /api/v1/images/generations {model,prompt}` → `{data:[{url}]}`; `callImageModel` returns the
  URL, `fetchAssetBytes` GETs it (NO auth — pre-authorized URL, like `downloadBytes`). Chosen over
  the chat-completions-`modalities`-base64 path because it cleanly splits API-call from byte-fetch;
  flagged implementation-time-verify in a `media-client.ts` comment.
- **assetId** = the generationId → `buildAssetKey(projectId, genId)` = `projects/{p}/assets/{genId}`
  (deterministic ⇒ idempotent PUT; no extension, ContentType on the S3 object). **Image generations
  MUST be project-scoped** — §8 has no project-less asset layout, so a null `projectId` is a
  PERMANENT `GenerationRequestInvalidError` (enforced in the workflow, NOT the API create schema).
- **S3 client placement** = a minimal internal-role factory in dbos's OWN `src/files/` (NOT db-lib):
  a client factory is wiring, not a cross-service FORMAT (only the KEY layout is shared, already in
  db-lib), and promoting it would push heavy `@aws-sdk/client-s3` into every db-lib consumer. dbos
  gained `@aws-sdk/client-s3@^3.717.0` (writer only — no s3-request-presigner; it never presigns).
- **image input schema** = `GenerateImageInputSchema = z.object({prompt:string().min(1)}).passthrough()`
  (db-lib), replacing task-31's `MediaGenerationInputSchema` placeholder for the `image` variant of
  `CreateAiGenerationRequestSchema` (image POST now 400s w/o a prompt). `prompt` (standard image term,
  = the OpenRouter field), NOT reusing `SceneVisualPromptSchema` (that's an LLM OUTPUT schema).

**dbos S3 plumbing (FIRST real S3 write):** `src/files/s3-client.ts` (`makeInternalS3Client` +
`uploadAsset` → `PutObjectCommand`, forcePathStyle) + `src/files/s3-config.ts` (a live-`S3Client`
singleton set in `launchDbos`, `clearS3Config()` destroys it in shutdown — same discipline as
providers/config + app-db). New required env `S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY` +
`S3_REGION`(default us-east-1) + optional-unused `S3_PUBLIC_ENDPOINT` (name-parity w/ api). Making
them required **rippled into ALL 7 existing e2e `loadEnv({...})` blocks + env.test.ts `validEnv()`**
(same pattern as task-29's SECRETS key). **In-process e2e must set `S3_ENDPOINT=localhost:9000`
(host-reachable), NOT `minio:9000`** (the in-process worker runs on the host).

**db-lib (released PR #24 → main `c1938fd`, next branch `v0.0.24`):** `workflows.ts` —
`GENERATE_IMAGE_WORKFLOW_NAME="generateImage"` + `AI_GENERATION_WORKFLOW_BY_KIND.image`. `schemas.ts`
— `GenerateImageInputSchema` + `GenerateImagePayloadSchema` + the image-variant switch. `image` is
now WIRED: `resolveAiGenerationWorkflow("image")` returns the target (no longer 501). **Bumped BOTH
consumers' nested submodule + Dockerfile ARG to `c1938fd`** (api `fe9d802`: 7cc5748→c1938fd = task-32
only; dbos `809e009`: e6e1de4→c1938fd = a BIGGER jump also picking up task-31's additive schemas — no
regression, task-30's TranslationSchema broadening was already in e6e1de4). This also flipped dbos's
previously-RED `dockerfile-database-lib-pin.test.ts` (task-29 ARG drift) to GREEN.

**Test edits from wiring image (recurring pattern — when a media kind gets wired, repoint the
"still-unwired 501" example to `narration`):** api `workflow-lookup.test.ts` (image→generateImage;
501 loop drops image), `ai-generations-service.test.ts` (501 example→narration; +image-wired test),
`routes/ai-generations.test.ts` (image payloads need a `prompt`), `ai-generations.e2e.ts` (replace
501-image with a wired-image test via a NEW stand-in `generateImage` worker; +400-no-prompt);
db-lib `ai-generation-schemas.test.ts` (image now requires prompt; passthrough example→narration),
`workflows.test.ts` (image in the map).

**Stub + e2e.** ROOT `tests/stubs/src/openrouter-stub.ts` gained `POST /api/v1/images/generations`
(→ `{data:[{url}]}`) + `GET /api/v1/images/download/:id` (raw FAKE_PNG) + `imageRequests` counter;
did NOT add an image model to the discovery catalogue (image uses no discovery — model comes off the
row). dbos `global-setup.ts` added minio/minio-init to the compose-up list + a `minioReady()` probe
(`GET {S3_PUBLIC_ENDPOINT}/minio/health/live`) + an image-route staleness probe in
`openRouterStubReady()`. dbos e2e `generate-image.e2e.ts` proves the workflow uploads a REAL object to
Compose MinIO at `projects/{p}/assets/{genId}` (read back via GetObject, PNG magic asserted) +
`resultAssetKey` set. Root compose `dbos` service gained the S3_* env block (mirrors `api`; not
exercised by the in-process e2e — containerized dbos boot is still deferred to task 46).

**Final green:** db-lib 308 unit + build; dbos 251 unit + typecheck + 22 e2e (8 files, +1
generate-image); api 305 unit + typecheck + 58 e2e (10 files, +2 image); root 77 unit (+1 stub image).
No regressions. Feature work left UNCOMMITTED for Step 7 (db-lib release + both submodule-bump commits
ARE committed, per [[in-flight-dblib-e2e-constraint]]).
