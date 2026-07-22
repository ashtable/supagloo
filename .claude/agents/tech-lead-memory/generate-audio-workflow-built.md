---
name: generate-audio-workflow-built
description: Task 33 built generateAudioWorkflow (narration TTS + music, ONE workflow, openrouter-only) in supagloo-nodejs-dbos + db-lib schema/routing wiring + stub speech-script; reuses the task-32 image media-workflow template and the bytes-never-checkpoint fold. Step-6 state — db-lib green in-sibling, dbos/api green pending the Step-13 release+submodule-bump.
metadata:
  type: reference
---

Built 2026-07-22 (plan task 33, M5), Step 6 of the designtocode orchestration. Plan:
`supagloo/scratch/task-33-generate-audio-workflow.md`. Design authority: design-delta §7 workflow 7.
Depends on [[generate-image-workflow-built]] (THE media-workflow template + bytes-never-checkpoint),
[[provider-call-layer-built]] (`requestSpeech`, discovery, retry consts, credentials),
[[ai-generation-api-built]] (the API surface it un-501s), [[in-flight-dblib-e2e-constraint]] (release
sequence). Only `video` (task 34) remains unwired after this.

**Shape.** `src/workflows/generate-audio.ts` registers `generateAudio` (queue `ai-generation`) —
ONE workflow covering BOTH audio kinds (`narration` TTS + `music`), dispatching by the row's `kind`
(the generateScript storyboard/script precedent). Both openrouter-ONLY (§9-Q2). `workflowID ===
AiGeneration.id`; payload the minimal `{generationId}` echo. NO repair loop (opaque bytes). **3 DBOS
steps** (design names 4): `loadRequestAndCredentials` (DISCOVERY_RETRY; validate kind∈{narration,music}
+ openrouter + projectId + per-kind input schema, verify OpenRouter connection w/o returning secret,
queued→running) → `synthesizeAndUploadAudio` (MEDIA_RETRY) → `persistResult`. Companions in
`src/workflows/generate-audio/`: `errors.ts` (copy of image's), `request.ts` (`parseAudioRequest(row)`
→ discriminated `AudioRequest`), `synthesize.ts` (pure `buildSpeechArgs`), `finalize.ts`. Writes ONLY
the `AiGeneration` row. Failure path mirrors image: outer try/catch → `recordFailure` only on
`isPermanentGenerationFailure`; transient + DBOS-cancellation propagate.

**KEY judgment — synthesizeAndUploadAudio is ONE step (D1, the task-32 D6 fold).** `requestSpeech`
returns the BYTES directly (not a URL like image), so folding call+upload is even MORE clear-cut: a
standalone callSpeech step would checkpoint the audio Buffer (~10x JSON bloat). Bytes stay step-local;
the step returns only the small checkpoint-safe `{ providerGenerationId }` (the X-Generation-Id header).
Retried atomically against the deterministic `buildAssetKey(projectId, genId)` (re-PUT overwrites).

**6 documented decisions (D1–D6, in the plan):**
- **D2 Music endpoint** = SAME OpenAI-Audio-Speech byte-stream (`POST /api/v1/audio/speech` via the
  existing `requestSpeech`), different model id, style label as `input`. Design pins no music REST
  contract ("same step shape") → reuse tested code, flag as an implementation-time assumption in
  `buildSpeechArgs` (verify vs real OpenRouter before prod). `durationSeconds` validated, not yet plumbed.
- **D3 Model from the ROW** (not in-workflow discovery) — the image precedent. Row's required `model` is
  the caller-resolved id; discovery infra (`providers/discovery.ts`, `?output_modalities=audio`) is the
  MECHANISM callers use, not a workflow step. So NO stub discovery-catalogue change (avoids perturbing the
  task-29 discovery e2e). The stub's existing `stub/speech-model` (`["audio"]`) already covers audio.
- **D4 Input schemas** = `GenerateNarrationInputSchema = NarrationSpecSchema.passthrough()` /
  `GenerateMusicInputSchema = MusicSpecSchema.passthrough()` (db-lib) — naming parity with
  `GenerateScriptInputSchema`/`GenerateImageInputSchema`, reusing the task-7 specs; the dbos workflow
  validates the row's `input` with these SAME schemas.
- **D5 Scene scoping** = ONE combined narration asset per run: concatenate per-scene `scriptText`s
  (array order, `\n\n`) into one `requestSpeech` input, one mp3 at `buildAssetKey`, `resultAssetKey` set,
  `sceneId` null. Whole-project bed (matches the wireframe). LIMITATION: true per-scene audio files are a
  future refinement (→ `resultJson:[{sceneId,assetKey}]`) if task-36 render needs per-scene boundaries.
- **D6 X-Generation-Id** = captured into `resultJson` as `{ kind, providerGenerationId }` (NO new Prisma
  column/migration). DIVERGES from image (which leaves resultJson null) — audio has a meaningful single
  provider request id. `providerJobId` stays null (no async-job pattern; that's video's).

**db-lib** (`~/code/supagloo-database-lib`, sibling, Step-6 UNCOMMITTED — released at Step 13):
`schemas.ts` — `GenerateNarrationInputSchema`/`GenerateMusicInputSchema`/`GenerateAudioPayloadSchema`
+ repointed the narration/music variants of `CreateAiGenerationRequestSchema` (video stays on
`MediaGenerationInputSchema`, now the LAST placeholder). `workflows.ts` —
`GENERATE_AUDIO_WORKFLOW_NAME="generateAudio"` + narration+music entries in
`AI_GENERATION_WORKFLOW_BY_KIND` (both → generateAudio, mirroring how storyboard+script both →
generateScript). **db-lib is GREEN in-sibling: 315 unit + tsc + build (new exports in dist).**

**API needs ZERO src changes** — `resolveAiGenerationWorkflow` reads the shared db-lib table, so wiring
narration+music routes them automatically (confirmed by reading workflow-lookup/service/routes). TEST
updates only (the recurring "when a media kind gets wired, repoint the still-unwired 501 example"
pattern — now → VIDEO): `ai/workflow-lookup.test.ts`, `ai/ai-generations-service.test.ts`,
`routes/ai-generations.test.ts`, `tests/e2e/ai-generations.e2e.ts` (+ a stand-in `generateAudio` worker,
narration/music-wired e2e). `narration`/`music` POST with `input:{}` now 400s at the Zod boundary.

**dbos** files: `src/workflows/generate-audio.ts` + the 4 companions + `dbos/registry.ts`
(`WORKFLOW_NAMES/WORKFLOW_QUEUE.generateAudio`) + `dbos/runtime.ts` (static import) + unit tests
(`request.test.ts`, `synthesize.test.ts`) + `registry.test.ts` update + `tests/e2e/generate-audio.e2e.ts`
(narration→MinIO mp3 checksum, music same shape, 503-then-200 clean retry via speech-script;
`speechRequests===2`) + a global-setup speech-script staleness probe. NO new dbos deps/env (S3 +
providers already wired by tasks 29/32).

**Stub** (ROOT `tests/stubs/src/openrouter-stub.ts`, allowed — root's own dir): added a programmable
`speechScript` queue + `POST /__admin/speech-script` + made `POST /api/v1/audio/speech` honor it
(non-2xx → error → MEDIA_RETRY) + reset in onReset. Music reuses the speech endpoint (D2) → no music
route; `speechRequests` counts both. Root unit `stub-openrouter.test.ts` +1 (10 green). Root unit 78 green.

**Step-6 test status + the in-flight window (IMPORTANT).** Per [[in-flight-dblib-e2e-constraint]]: dbos/api
consume db-lib through their NESTED submodule (`node_modules/@supagloo/database-lib` → the pinned checkout,
currently `c1938fd`), NOT the sibling. This task's Step-6 prompt EXPLICITLY defers the db-lib release +
submodule bump to Step 13 ("Do NOT run /release or touch submodule pointers"). Consequence, honestly:
db-lib is fully RED→GREEN in-sibling NOW; dbos/api code+tests are authored+implemented but can only go
GREEN once Step 13 releases db-lib + fast-forwards+rebuilds the nested submodule + syncs the Dockerfile
ARG. Proven cleanly: the dbos `synthesize.test.ts` (imports only erased TYPES) is **7/7 GREEN now**
(the buildSpeechArgs logic is verified independent of the bump); `request.test.ts` fails 6/6 PURELY on
`GenerateNarrationInputSchema===undefined` from the stale submodule — the textbook in-flight window, not a
logic defect. FLAGGED for human confirmation: the Step-6 prompt ("defer release") contradicts this repo's
memory + auto-memory ("release db-lib immediately, never fake"); I followed the explicit current prompt and
did NOT symlink-override or bump. Nothing committed (Step 7/13).
