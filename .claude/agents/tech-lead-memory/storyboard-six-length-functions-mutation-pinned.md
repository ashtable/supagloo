---
name: storyboard-six-length-functions-mutation-pinned
description: nextjs storyboard's six length functions are pinned by a narration-stretched fixture (U-S14..U-S19); sceneEntryFrame's authored-duration clamp is a DELIBERATE exception, not a bug
metadata:
  type: context
---

supagloo-nextjs `lib/studio/storyboard.ts` claims (docstring at `sceneRange`) that six
functions turn a scene into a LENGTH via `effectiveSceneDurationSeconds`:
`totalDurationSeconds`, `totalFrames`, `sceneRange`, `sceneAtFrame`, `timelineWeights`,
`sceneBoundaryFractions`. Until 2026-07-27 every length test drove `DEMO_STORYBOARD`,
which carries NO `narrationDurationSeconds` — so `effective` collapsed to the raw
`durationSeconds` and all seven tests were vacuous for that claim (a `[[a-test-that-claims-a-class-must-drive-the-class]]` instance).

Now pinned by the `STRETCHED` fixture + describe "narration-stretched lengths"
(U-S14..U-S19) in `lib/studio/storyboard.test.ts`: effective [5,12,8,8] vs authored
[5,9,8,8] (s2 stretched 9→12 by narration, s3's shorter narration proves the rule is
`max`, not narration-wins). Mutation-verified 2026-07-27: reverting `effective…(s)` to
`s.durationSeconds` in ANY of the six kills at least one of U-S14..U-S19 (all six
mutations run individually, all killed; `rm -rf node_modules/.vite` between runs per
[[vite-cache-poisons-mutation-testing]]).

**Gotcha:** `sceneEntryFrame` (storyboard.ts:175) uses raw `scene.durationSeconds` for
its settle-offset CLAMP while taking its start from `sceneRange` (effective). That is a
deliberate conservative clamp, correctly absent from the docstring's list of six — do
NOT "fix" it to effective; U-S12/U-S13 pin the current behavior.
