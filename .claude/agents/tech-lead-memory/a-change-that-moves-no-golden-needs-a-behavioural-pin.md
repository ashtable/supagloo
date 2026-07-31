---
name: a-change-that-moves-no-golden-needs-a-behavioural-pin
description: Adding `muted` to <OffthreadVideo> and ducking the music both moved ZERO goldens, so both would have shipped unpinned — the bundle-lane recipe that made them falsifiable, and the three mutations that proved it
metadata:
  type: convention
---

Learned 2026-07-30 fixing the render audio mix in `supagloo-nodejs-dbos`.

**Two real changes moved zero golden bytes.** `dbos/src/remotion/__golden__/shelter/` has no
video-kind scene (both fixtures are stills) and no per-scene narration, so
`<OffthreadVideo muted>` and the whole music-duck were invisible to the byte-for-byte
goldens. The only existing coverage of the video branch was `U-T10`'s
`toContain("<OffthreadVideo")` — and a second `toContain("muted")` would have pinned the
STRING, not the silence. **When a change moves no golden, ask what would go red if you
reverted it; if the answer is "a substring assertion you also just wrote", it is unpinned.**

## The recipe (bundle lane — no Postgres, no DBOS, no GitHub, no credits, ~2 s per render)

`tests/e2e/render-bug-proofs.bundle.e2e.ts` already had everything:
`renderMedia({codec:"wav"})` for an audio-only render, `windowLevel()` for mean amplitude in
a time window, and `renderMp4()` to manufacture a real clip (Remotion's compositor refuses
to seek a still as a video).

**Muting.** A clip with a LOUD soundtrack is the hard part: render a throwaway project whose
only content is a narration tone, to H.264. Then two assertions —
- `E-V0` (precondition): the source composition's window is loud **and** the MP4 contains an
  `mp4a` fourcc. Without this, `E-V1` is unfalsifiable — a silent source makes "the clip's
  window is silent" true no matter what.
- `E-V1`: scene 1 = that clip (silent), scene 2 = a still with narration (loud). The second
  window is the in-test control: it proves the pipeline and the measurement work.

**Ducking.** `windowLevel` measures the SUM, so a narration TONE drowns the thing under
test. **Use a SILENT narration clip** (`silentWav`): the duck window is derived from the
manifest (`narrationAssetKey` + `narrationDurationSeconds`), not from the audio, so the
window exists and the measured level is the music alone. `E-D2` re-renders the identical
manifest with the narration key removed and asserts the same three windows are LEVEL.

## Mutation-verify, or it is still decoration

`rm -rf node_modules/.vite` between runs ([[vite-cache-poisons-mutation-testing]]).

| mutation | killed by |
|---|---|
| drop `muted` | `E-V1` — and `E-V0` stayed green, so the precondition is genuinely independent |
| duck level 0.12 → 0.4 (no-op) | `E-D1` |
| duck level 0.12 → 0 (full mute) | `E-D1`'s `> 0.002` arm, **on its own** |

That third one is why "ducked, not muted" is a separate assertion: a bed that vanishes under
every verse passes any "quieter than before" test and is a different bug.

## Two generator gotchas

- **Never emit a computed float.** `MUSIC_VOLUME - MUSIC_DUCK_VOLUME` is
  `0.28000000000000003`; emit both constants and let the generated source do the arithmetic.
- **`loopVolumeCurveBehavior="extend"` got MORE load-bearing.** Under the default `"repeat"`
  the duck (not just the tail fade) re-fires every loop iteration, so the bed dips at moments
  nobody is speaking. See [[remotion-css-and-loop-gotchas]].
- Overlapping/adjacent duck windows must take the **minimum** gate, or two consecutive
  narrated scenes un-duck each other where both ramps are live.

Related: [[a-test-that-claims-a-class-must-drive-the-class]],
[[a-baseline-must-hold-every-other-variable-equal]],
[[render-bugs-narration-music-kenburns-built]].
