---
name: studio-ai-wiring-nextjs
description: Task 35 (M5, closes it) wired the studio's AI actions (reroll visual / rewrite script / re-plan storyboard / narrator-voice / music-bed / first-time generate) to the real POST /v1/ai/generations + polling + presign, with presigned previews and commit-persisted asset refs; the BFF injects provider/model; db-lib VoiceDescriptor gained assetKey
metadata:
  type: convention
---

Built 2026-07-24 (plan task 35, M5 — the last M5 task). **nextjs-only** except one
small **db-lib** schema add. TDD plan: `supagloo/scratch/studio-ai-wiring.md`. Builds
on [[studio-hydration-commit-wired-nextjs]] (27) + [[ai-generation-api-built]] (31) +
the media workflows (32–34). Realizes design-delta §5.3, §6b.

**db-lib change (real, green in-sibling): `VoiceDescriptorSchema` gained
`assetKey: z.string().min(1).nullable().optional()`** (mirrors `MusicBedSchema.assetKey`)
so the WHOLE-PROJECT narration track can persist on the manifest's `narratorVoice`. Done
in the SIBLING repo (`~/code/supagloo-database-lib`, branch `v0.0.26`, HEAD was `64af3e9`),
its own tests green (326), built. Per [[in-flight-dblib-e2e-constraint]] the submodule
bump into api/nextjs is a LATER release step. Consequence: the narration-asset-survives-
commit path is **green-pending the api db-lib bump** (else the API's Zod strips the unknown
`narratorVoice.assetKey` at commit). The IMAGE-asset survival path needs NO bump
(`ManifestScene.visualAssetKey` already exists) — that's what the always-on e2e proves.

**nextjs uses a hand-mirror, NOT a db-lib import** ([[studio-hydration-commit-wired-nextjs]]):
`lib/api/contracts.ts` got the AI mirrors (AiGenerationKind/Provider/JobStatus, the
`CreateAiGenerationRequest` discriminated union, `AiGenerationDto`, Generated Script/
Storyboard, `FilePresignDownloadResponse`) + `VoiceDescriptor.assetKey`. So nextjs's OWN
suite goes fully green now without any bump.

**Q6 (model/provider) — the judgment call.** The create contract REQUIRES `model`, the
generation workflows consume `request.model` directly (verified: generate-image.ts uses it
as modelId — NO re-discovery), and there is NO model-discovery API/BFF route. So the client
posts only `{kind, projectId?, sceneId?, input}` and the **BFF route enriches `{provider,
model}` server-side** via `resolveGenerationTarget(kind)` (`lib/api/ai-config.ts`, env-
overridable `SUPAGLOO_AI_MODEL_<KIND>`/`SUPAGLOO_AI_PROVIDER_<KIND>`, provider=openrouter
default = matrix-valid for every kind). Fallback model ids are the last-known-good live ids
from the 2026-07-24 e2e run (text `google/gemma-4-26b-a4b-it:free`, image
`google/gemini-2.5-flash-image`, narration `openai/gpt-audio-mini`, music
`google/lyria-3-clip-preview`, video `alibaba/wan-2.7`). Keeps the id in ONE server-side
place (not in the client bundle), honouring "never hardcode" in spirit; a real discovery
endpoint is the correct follow-up.

**Reducer generation machine (the pending/failed/success coverage).** New
`StudioState.generations: Record<slot, {status:"running"|"failed"; error?}>`, slot keys via
`imageSlot(id)`/`scriptSlot(id)`/`STORYBOARD_SLOT`/`NARRATION_SLOT`/`MUSIC_SLOT`. Pure
outcome mappers (like commitOutcome) map a POLLED terminal `AiGenerationDto` (+ presigned
url / parsed resultJson) → the settling action: `imageGenerationOutcome`,
`scriptGenerationOutcome`, `narrationGenerationOutcome`, `musicGenerationOutcome`,
`storyboardGenerationOutcome`. Success actions clear the slot + set the storyboard fields +
dirty (so the ref commits); failure leaves `{status:"failed"}` (retryable). `SET_SCENE_VISUAL_URL`
(hydrate-time presign) sets the url WITHOUT dirtying.

**Preview + presigning (Q5).** `Scene` gained `visualAssetKey?`(persisted) + `visualUrl?`
(ephemeral); `Storyboard` gained `narrationAssetKey`/`musicAssetKey` (persisted) +
`narrationUrl`/`musicUrl` (ephemeral). Presigning lives in the DATA layer:
`presignStoryboardAssets` (studio-data.ts) runs inside `loadStudioProject` (injectable
fetch, unit-tested), and a reroll re-presigns in the effect layer. `storyboard-video.tsx`
renders a Remotion `<Img data-testid="scene-visual">` when `visualUrl` is set (falls back
to the gradient) + `<Audio>` for narration/music. Ephemeral URLs are NEVER serialized —
`serializeManifest` writes only the asset KEYS.

**Effect layer** (`lib/studio/ai-generation-data.ts`, mirrors studio-data.ts): injectable
fetch, Zod-parse, null on failure — `createGeneration` (client body has NO provider/model),
`fetchGeneration`, `presignDownload`, `pollGenerationUntilTerminal` (longer defaults than
git-ops: 1.5s/300s). Context methods (`rerollVisual`/`rewriteScript`/`generateStoryboard`/
`regenerateNarration`/`regenerateMusic`) mirror commit(): dispatch BEGIN → guarded
`void(async…)()` with `aliveRef` → poll → (media: presign) → dispatch outcome. **All no-op
when `!project.manifest`** (mock catalog).

**Surfaces wired (Q1–Q4).** Inspector `↻ Reroll visual` → image (the flagship path);
RerollMenu popover options → image / script / storyboard; `StudioEmpty` gained a
first-time `generate-storyboard` button (kind storyboard). Narrator-voice + music-bed
controls (editable + regenerate) render **only in real mode** (`project.manifest`) — the
mock catalog keeps the canonical 13b READ-ONLY inspector byte-for-byte so the 31 mock
studio specs stay green (a controlled `<textarea>` value is NOT in `textContent`, which the
`E2` exact-copy anchor test reads → gating avoided that break; verified by running
studio.e2e 16/16 + studio-project 4/4). The inspector exposes `data-visual-asset-key` for
the e2e.

**New BFF routes** (thin `forwardToApi`): `app/api/ai/generations/route.ts` (POST — the
ONLY one with logic: injects provider/model), `app/api/ai/generations/[id]/route.ts` (GET),
`app/api/files/presign-download/route.ts` (GET `?key=`).

**GOTCHA fixed (tsconfig hygiene, at user request).** nextjs `tsconfig.json` `include`
`**/*.ts` was compiling the NESTED `supagloo-database-lib/` submodule checkout (a
self-contained package with its OWN tsconfig/package.json, pinned + unbuilt), producing
pre-existing pinned-client tsc errors that [[studio-hydration-commit-wired-nextjs]] just
documented as out-of-scope. Nothing in app/lib imports it (contracts.ts is the hand-mirror)
and next.config has no `ignoreBuildErrors`, so it was also a latent local `next build`
hazard. Fix: added `supagloo-database-lib` + `supagloo-prompts` to tsconfig `exclude` (like
node_modules). `npx tsc --noEmit` is now FULLY clean unfiltered.

**e2e** `tests/e2e/studio-ai-generation.e2e.ts` (deterministic, Gloo-free, per-run nonce —
the established studio convention, NOT act/extract/observe): reroll visual → real OpenRouter
→ MinIO asset → preview `<Img>` + `data-visual-asset-key` becomes a real `projects/…/assets/…`
key → Commit → re-open persists. Self-contained flow (create → real `generate-storyboard`
→ reroll) OR a `SUPAGLOO_E2E_STUDIO_SLUG` fixture fast-path. **Execution DEFERRED** to the
release step (needs `next dev` + locally-built API + ai-generation worker + git-ops commit
worker), same posture as tasks 27/28; behavior proven meanwhile by the unit suite.

**Final green:** db-lib 326 unit + build; nextjs 409 unit (39 files) + `tsc --noEmit` clean
(unfiltered) + eslint clean + mock studio e2e green (studio 16 / studio-project 4 /
studio-publish). Not committed (Step 7). Known follow-up: a real model-discovery API/BFF
route to replace the env-defaulted model ids; threading generated per-scene references
through the UI Scene (a storyboard replan currently preserves base/placeholder references
since the UI Scene has no reference field).
