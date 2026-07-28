---
name: a-lane-that-builds-its-own-inputs-cannot-prove-the-producer
description: The render bundle e2e hand-wrote assets into public/, so it structurally could not see that manifestAssetKeys never downloaded per-scene narration — a render-killing blocker; plus the UNION invariant that replaced it and why the obvious phrasing of that invariant is false
metadata:
  type: constraint
---

Found by review 2026-07-27 in `/Users/ash/code/supagloo-nodejs-dbos` (render-bugs run,
finding R1), fixed the same day. Companion to
[[an-isolation-seam-can-hide-the-property]] and
[[a-test-that-claims-a-class-must-drive-the-class]].

## The shape

`tests/e2e/render-bug-proofs.bundle.e2e.ts` proves three real properties of the generated
Remotion composition against a real bundler, real Chromium and a real encode. To do that,
its `buildProject` helper writes the scene/audio assets into the project's `public/` dir
**by hand**.

That is the right call for what the lane is for — it needs no Postgres, no DBOS, no GitHub,
no provider credits. But it means the lane **manufactures the exact inputs whose production
is the thing under suspicion.** `ensureSceneAssets` — the only code that downloads S3
objects into `public/` — is never on its path. So when `manifestAssetKeys` omitted
`scene.narrationAssetKey`, seven green proofs said nothing about it.

**The generalization:** a lane that constructs its own inputs can prove properties of the
CONSUMER and never a property of the PRODUCER. Ask of every green proof lane: *what does it
build itself?* — that set is its blind spot, and the blind spot needs its own assertion
surface, not a bigger version of the same lane.

## Why it was a blocker, not a degradation

The review first wrote "the video loses narration on every scene after the first". That
understates it. Verified in the pinned `@remotion/renderer@4.0.490`:
`dist/assets/read-file.js` throws on any `statusCode >= 400`, and
`dist/assets/download-and-map-assets-to-file.js` calls it with **no catch**. `getAssetUrl`
resolves to `staticFile(assetKey)`, so an unmaterialized key 404s off the dev server and
**the render fails outright**. Remotion does not degrade on a missing asset — check that
before pricing any "the media just won't play" finding in this codebase.

## The invariant — a UNION, and the obvious phrasing is FALSE

The tempting rule is "every `getAssetUrl` constant the generator emits must appear in
`manifestAssetKeys`". Implement that literally and the test only passes on the narrow case,
because `render.ts` feeds the two sides **different manifests on purpose**:

- `ensureSceneAssets(ws, ctx.manifest)` — the manifest as committed
- the generator ← `applyAudioPlans(ctx.manifest, ctx.audioPlans)`

So on the render-time synthesis fallback the composition legitimately emits
**workspace-local** keys (`render-audio/narration-{id}.mp3`, `render-audio/music.wav`) that
`manifestAssetKeys` must NOT contain — there is no S3 object behind them. The correct rule:

> every key the generated composition resolves through `getAssetUrl(...)` is materialized by
> exactly one of the two materializers — `ensureSceneAssets` (downloads
> `manifestAssetKeys(manifest)`) or `ensureAudioOnDisk` (writes the `render-audio/…` keys
> the active `AudioPlans` carry).

Held by `src/workflows/render/assets.test.ts`, which extracts the emitted set from the
generated `.tsx` **independently of the implementation** (scan `getAssetUrl(<ident>)`, then
read that identifier's own `const <ident> = <json>;`) and checks the subset against the
union, across three cases: maximal, v1/legacy (`legacyNarrationKey` branch), and
render-fallback. A superset is safe; a subset is a hard render failure.

## Placement gotcha

`manifestAssetKeys` lived in `render.ts`, which calls `DBOS.registerWorkflow` at module
load — importing it from a test costs the 40-line `vi.mock("@dbos-inc/dbos-sdk", …)` that
`render.order.test.ts` carries. Moving it to a pure `src/workflows/render/assets.ts` (the
existing `render/audio.ts` + `render/audio.test.ts` convention) made the test mock-free.
**In this repo, "extract it to a pure sibling module" is usually cheaper than mocking the
DBOS SDK.**
