---
name: render-bugs-narration-music-kenburns-built
description: The three genesis-1 render fixes — per-scene narration via the dedicated speech endpoint, music looped to the composition, deterministic Ken Burns — plus the manifest fields, the four mirrors, and the bundle-lane proof spec
metadata:
  type: decision
---

Three bugs in genesis-1's first render, fixed together because they all land in the same
generated composition. Live provider evidence is in [[openrouter-audio-live-contract-facts]];
the Remotion traps are in [[remotion-css-and-loop-gotchas]].

## What changed

**Narration.** Moved off chat-completions onto `POST /api/v1/audio/speech`
(`requestSpeech`). The fix is STRUCTURAL: that endpoint takes an `input` string and has no
`messages` array, so a conversational reply is unreachable — not a matter of prompting. And
narration is now synthesized ONE CLIP PER SCENE, mounted inside that scene's own
`<Sequence>`, which is the sync mechanism that did not previously exist in any form.

**Music.** Two independent causes. The dominant one was ours: `wavFromPcm16` was wrapping
MP3 bytes in a 24 kHz-mono RIFF header, halving the apparent length. Now `sniffAudioBytes`
passes the provider's container through untouched. The second is the composition:
`<Loop durationInFrames={round(measured*fps)}>` + a tail fade covers the video regardless of
what length the provider felt like returning.

**Ken Burns.** `visualAssetKind` ("image"|"video", absent ⇒ image) discriminates still from
clip. Stills get a `scale`/`translate` pan normalized over the scene's own frame count, with
the variant chosen by `index % 4` — never randomness or a clock, because the generator is
golden-pinned and re-run at render time. Clips get `<OffthreadVideo>`, closing a latent bug
where a video asset was rendered through `<Img>`.

## Decisions worth remembering

- **ONE AiGeneration row, N assets.** `resultAssetKey` stays a single key (scene 1's); the
  per-scene map rides in `resultJson.narration` (`NarrationResultSchema`). N rows would have
  meant redesigning the studio slot model, the BFF, the API route and the render UI for no
  user-visible gain. One DBOS step per scene, iterating the CHECKPOINTED request so replay
  order is deterministic.
- **The scene STRETCHES to fit its narration** — `effectiveSceneDurationSeconds` =
  `max(durationSeconds, narrationDurationSeconds ?? 0)`. Derived, never written back:
  `durationSeconds` is user-editable, so overwriting it would discard a chosen value and
  ratchet upward on every regeneration. **Six** nextjs functions turn a scene into a length
  (`totalDurationSeconds`, `totalFrames`, `sceneRange`, `sceneAtFrame`, `timelineWeights`,
  `sceneBoundaryFractions`) — miss one and the scrubber desyncs from the `<Sequence>` layout.
- **`MusicBed.durationSeconds` is MEASURED, not requested.** No music model accepts a length,
  so the field's only job is telling the composition how far to loop.
- **Per-scene S3 keys must stay FOUR segments.** `parseS3Key` matches project assets on
  `segments.length === 4` exactly and the presign route 404s a null parse — so
  `buildSceneNarrationAssetKey` folds the scene into the assetId SEGMENT
  (`projects/{p}/assets/{genId}-scene-{sceneId}`), NOT a nested path. A nested key would have
  made every per-scene narration preview 404 as "not found".

## The mirrors (all four, every time)

db-lib `schemas.ts` → dbos `manifest-json.ts` `canonicalizeManifest` (symmetrically, or a
commit silently erases the field) → nextjs `lib/api/contracts.ts` → nextjs
`lib/studio/manifest-adapter.ts` **both directions**. Plus two hand-mirrored RULES that
nextjs cannot import: `lib/studio/scene-duration.ts` and `lib/studio/ken-burns.ts` (the
motion table is pinned verbatim by a test so a one-sided edit fails rather than shipping a
preview that disagrees with the render).

## The proof spec — put render claims in the BUNDLE lane

`tests/e2e/render-bug-proofs.bundle.e2e.ts`. All three claims are properties of the GENERATED
COMPOSITION, not of the workflow that fetches its inputs — so they need no Postgres, no DBOS,
no GitHub, no provider credits. The bundle lane has no globalSetup, and `*.bundle.e2e.ts`
auto-joins it (dbos lanes are by filename suffix; no registration edit). Real bundler, real
headless Chromium, real encode.

Techniques worth reusing:
- `renderMedia({codec: "wav"})` gives an audio-only WAV; measuring mean amplitude in a time
  WINDOW turns "the music covers the video" and "narration starts with its scene" into
  falsifiable assertions.
- Fixtures must be able to SHOW the property: a 1×1 PNG looks the same however far you pan
  it, and silence is indistinguishable from a track that stopped. `src/testing/media-fixtures.ts`
  generates a hard-edged checkerboard PNG (hand-rolled encoder, ~40 lines) and sine-tone WAVs.
- Compare stills at frames PAST the 15-frame caption fade, or the fade's own pixel change
  masquerades as motion. Render the same frame twice as a determinism control.
- **Every proof carries a control that must come out the other way** (no measured length ⇒
  the tail IS silent; a video-kind scene's frames ARE identical).
