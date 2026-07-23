---
name: task-34-e4-dbos-e2e-real-provider-generate
description: 34-E4 flipped the four generate-*.e2e.ts to real OpenRouter + a direct-DB credential seed helper + a shared DBOS system-DB step-introspection helper
metadata:
  type: decision
---

Task 34-E4 (dbos-only, M5) de-stubbed the four `tests/e2e/generate-{script,image,audio,video}.e2e.ts`
specs to run against **real OpenRouter** and replaced fabricated
`prisma.openRouterConnection.create(encryptSecret("sk-or-test-key"))` seeding.

**New shared test-infra (all in `supagloo-nodejs-dbos/src/testing/**`, excluded from
`dist` via `tsconfig.build.json` so they unit-test in the fast docker-free lane):**
- `seed-connections.ts` — `resolveGenerationSeedCreds` (fail-fast naming missing
  `OPENROUTER_E2E_TEST_API_KEY`/`GLOO_CLIENT_ID`/`GLOO_CLIENT_SECRET`),
  `seedOpenRouterConnection` (direct DB write, `encryptSecret(realKey)`, no verify),
  `seedGlooConnection` (live-mint via `mintGlooToken` FIRST → abort seed if it throws →
  only then write row). Mirrors the api-side `src/testing/seed-connections.ts` (34-E3)
  SHAPE but the mechanism is **direct DB write**, NOT HTTP connect routes (dbos is
  self-contained — never calls the API container, §10.3/§9-Q9). Unit-tested with
  injected fake prisma + injected `mintToken`.
- `step-introspection.ts` — `countStepExecutions(client, workflowID, namePrefix)` over
  `DBOSClient.listWorkflowSteps` (SDK 4.23.6; `StepInfo` is NOT re-exported from the
  index → derive via `NonNullable<Awaited<ReturnType<…>>>[number]`). **PREFIX-match**,
  not exact: generate-script's repair loop re-registers the same step as
  `callLlmStructured`, `callLlmStructured:repair:1`, …. Internal `retriesAllowed`
  retries do NOT add rows (one StepInfo per functionID). This is the §10.5 durability
  probe that replaced the stub `videoJobsCreated`/`chatCompletions` counters; **34-E7
  reuses it**.
- `e2e-models.ts` — `pickCheapestModelId` (prefer `:free`, else `[0]`, throw on empty)
  + `resolve{Text,Image,Audio,Video}Model(env)` via the OpenRouter-only
  `discoverModels`/`discoverVideoModels`. Model ids are resolved at SEED time and
  written onto `AiGeneration.model` (workflows read the column; they don't discover).

**Three open-question decisions:**
1. generate-video **crash/replay** describe → `it.todo("… reworked in 34-E7")` (plan.md
   reserves it for 34-E7). Only the video **happy path** was reworked (swapped
   `videoJobsCreated` → `countStepExecutions("submitVideoJob")===1`).
2. `imageRequests`/`speechRequests` stub counters → replaced with a system-DB
   single-execution check on the provider step (`callImageModel` /
   `synthesizeAndUploadAudio`), not dropped — preserves the "no-retry" regression guard
   at zero provider cost.
3. generate-script crash/replay runs a naturally-successful **brief-only storyboard**
   (dropped `scripture` — it's `.optional()`, so `fetchScripturePassage`/YouVersion is
   skipped entirely, keeping YouVersion out of scope). Reuses
   `__setGenerateScriptBoundaryHook` to park at `persistResult`; proof = LLM step count
   UNCHANGED across cancel+resume + `GeneratedStoryboardSchema` parses `resultJson`.

**Key decision — e2e is OpenRouter-ONLY; the Gloo seed path is unit-proven.** There is
NO Gloo discovery in the codebase (`discoverModels` hits OpenRouter only), so a live
Gloo generation would require a hardcoded gloo model id — forbidden by §10.9 ("resolve
via discovery, never hardcode"). The E2E-target line itself says "models resolved via
discovery" → OpenRouter. Live Gloo verify/mint is already covered at the api layer
(34-E3's `PUT /v1/connections/gloo`). See [[api-e2e-real-provider-connection-seeding]],
[[e2e-secrets-gloo-naming-collision]], [[generate-script-workflow-built]],
[[generate-video-workflow-built]].

**§10.9 cost mitigations applied:** discovery-resolved ids (never hardcoded), minimal
media params, no extra live cases. The dedicated low-balance `OPENROUTER_E2E_TEST_API_KEY`
(in dbos `.env`) caps runaway spend.

**LIVE-RUN FINDINGS (2026-07-23, real key against real OpenRouter) — IMPORTANT:**
- **generate-script → GREEN.** But the first live run FAILED: the naive `:free`/`[0]`
  model pick chose `poolside/laguna-s-2.1:free` (a coding model) which HUNG → 150s
  timeout. Fix: `resolveTextModel` now reads `/api/v1/models` metadata and picks the
  CHEAPEST model with `structured_outputs` support (§10.9 "cheapest **adequate**" — a
  model that can't honor a JSON schema is not adequate). Re-ran → passed in ~32s. So the
  whole harness (seed helper, discovery, real `generateObject`, park/cancel/resume,
  `countStepExecutions`) is validated end-to-end.
- **generate-image → BLOCKED (real bug in production media-client, NOT this task's fix).**
  `POST /api/v1/images/generations` → **404** on real OpenRouter. The endpoint exists
  only in the stub; real OpenRouter does image gen via chat-completions with
  `modalities:["image"]` (the media-client's own comment even flags "verify against live
  OpenRouter"). `media-client.requestImage` targets a nonexistent endpoint.
- **generate-audio → BLOCKED (same class).** `/api/v1/audio/speech` is not a functional
  route on real OpenRouter (GET→404; POST→400 "Model … does not exist" for every audio
  model). Real OpenRouter audio output is via chat-completions audio modality, not an
  OpenAI-TTS-shaped `/audio/speech`. `media-client.requestSpeech` targets a stub-only
  endpoint.
- **generate-video → submit+poll+completion WORK; blocked only at content download.** Two
  submit mismatches were FIXED in the harness: (1) naive `[0]` pick
  (`grok-imagine-video-1.5`) is image-to-video-only → 400 "Text-to-video is not supported";
  fix = `resolveVideoModel` reads `/api/v1/videos/models` metadata, picks a model whose
  description advertises **text-to-video** (`alibaba/wan-2.7`, min 2s) with smallest
  `supported_durations`; (2) seed now sends only `{prompt, durationSeconds:minDuration}`
  (no aspectRatio — not universal). After that the workflow submitted, polled to
  `completed`, and got the content response, then FAILED at `downloadAndUploadVideo` with
  `SyntaxError: … "ftypis"… is not valid JSON`. **Root cause (real contract, confirmed):**
  the poll/status response `GET /api/v1/videos/{id}` already returns
  `unsigned_urls:["…/content?index=0"]` + `usage.cost`; the content endpoint
  `GET …/content?index=0` returns `content-type: video/mp4` + **raw mp4 bytes**. But
  production `media-client.getVideoContentUrls` does its OWN `GET …/content` and
  `res.json()` → parses mp4 bytes as JSON → throws. Fix belongs in the production
  media-client (capture `unsigned_urls` from the poll response, download the bytes directly
  with auth), a separate task. **Cost: $0.50 per clip** (`usage.cost:0.5`) — do NOT iterate
  paid video runs to verify a production fix under an e2e task.

**EXPANDED SCOPE (user decision, same day): the production media-client contracts were
FIXED in this task.** Real OpenRouter contracts (all confirmed live), now implemented in
`src/providers/media-client.ts` + the three workflows:
- **Image** — NO `/api/v1/images/generations`. Real: NON-stream
  `POST /chat/completions {model, messages, modalities:["image"]}` → image inline as a
  base64 `data:` URI in `choices[0].message.images[0].image_url.url`. `requestImage` now
  returns `{bytes, contentType}`; `generateImageWorkflow` folds callImageModel+upload into
  ONE step (bytes inline, never checkpointed). Cheapest working image model:
  `google/gemini-2.5-flash-image` (~$0.04); the free image tier (krea) 500s, so
  `selectCheapestImageModel` requires a CONCRETE POSITIVE `pricing.image`.
- **Audio** — NO `/api/v1/audio/speech`. Real: STREAMING
  `POST /chat/completions {modalities:["text","audio"], audio:{voice?,format:"pcm16"}, stream:true}`
  → SSE `choices[0].delta.audio.data` base64 PCM16 (non-stream/mp3 rejected). `requestSpeech`
  now buffers the SSE, concats PCM16, WAV-wraps (24 kHz mono), returns `{bytes(WAV),
  generationId, contentType:"audio/wav"}`. Narration = a TTS model (`openai/gpt-audio-mini`)
  + a FIXED valid voice enum `"alloy"` (the freeform descriptor isn't a valid voice id);
  music = a Lyria model (`google/lyria-3-clip-preview`, ~$0.04) with no voice — BOTH return
  `delta.audio.data` identically (D2 holds). `resolveAudioModel(env, kind)` selects
  TTS-vs-Lyria via description/id. KNOWN LIMITATION: WAV rate fixed at 24 kHz (correct for
  gpt-audio; Lyria rate may differ → music playback speed could be off; flagged).
- **Video content** — poll body `GET /videos/{id}` carries `unsigned_urls` once completed;
  `GET …/content?index=0` returns raw mp4 bytes and REQUIRES the bearer (401 without).
  `getVideoJob` now returns `unsignedUrls`; `getVideoContentUrls` REMOVED; `downloadBytes`
  now sends auth; `generateVideoClipWorkflow` re-reads the completed job for `unsignedUrls[0]`
  and downloads with auth. Cost ~$0.50/clip.

Model resolution (§10.9) now reads richer discovery metadata per modality (text →
`structured_outputs`; image → concrete positive price; audio → TTS-vs-Lyria by kind; video →
text-to-video + min duration) — never `:free`/`[0]` (which picked incapable/500-ing models).
The video crash/replay remains deferred to 34-E7.

**Step-11 review-revision pass (commit 2d3a801 on v0.0.26, 2026-07-23):** two follow-ups
the code review surfaced. (1) `tests/e2e/providers.e2e.ts` still had stub-era media-client
PRIMITIVE it() blocks that broke under the fixed contracts — the video block called the
now-REMOVED `getVideoContentUrls` (TypeError at run time), the speech block asserted the stale
`audio/mpeg` type (`requestSpeech` returns `audio/wav`). This file is in the e2e glob but NOT
typechecked (tsconfig = `src/**` only), so it slipped through. Both blocks were neutralized with
`it.todo("… reworked in 34-E8")` (same precedent as generate-video.e2e's crash/replay
`it.todo("… 34-E7")`); the file is otherwise UNTOUCHED (still stub-based, orphaned imports left
in place) — **34-E8 owns the full rework** (flip to real hosts, invert the stub guard, delete the
whole media-client primitives section as duplicative of 34-E4/34-E7 workflow coverage). (2) Dead
`?? "audio/mpeg"` fallback removed from generate-audio.ts (`SpeechResult.contentType` is
non-nullable) + stale "raw mp3 byte stream"/"X-Generation-Id header" doc comments corrected across
generate-audio.ts + generate-audio/finalize.ts (real: SSE→WAV-wrapped PCM16, generationId from
`delta.audio.id`) + generate-audio.e2e describe string mp3→wav. No behavior change; 334 unit green.
