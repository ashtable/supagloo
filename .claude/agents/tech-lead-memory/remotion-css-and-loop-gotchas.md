---
name: remotion-css-and-loop-gotchas
description: Two verified Remotion/React traps — React mangles a numeric `scale` into `scale:1.1px`, and a whole-video music fade needs loopVolumeCurveBehavior="extend"
metadata:
  type: constraint
---

Both verified directly against the installed versions (remotion 4.0.490, react-dom 18.3.1),
not from docs.

**1. `scale` MUST be a STRING in a React inline style.** React's `isUnitlessNumber` table
does NOT contain `scale` (it has `opacity`, `zoom`, `flex`, `lineHeight`, … but not the
modern `scale`/`translate`/`rotate` shorthands). Proven with `renderToStaticMarkup`:

    style={{ scale: 1.1 }}   ->  style="scale:1.1px"   // invalid CSS; the zoom does NOTHING
    style={{ scale: "1.1" }} ->  style="scale:1.1"     // correct

`translate` is unaffected (its values already carry units). This fails SILENTLY — no
warning, no error, just no motion — so it is a golden-passing, test-passing no-op unless
something asserts real pixels moved. `interpolate` has a string-outputRange overload at
4.0.490, so `interpolate(frame, [0, n], ["1", "1.1"], …)` returns a string directly and
keeps the call inline.

`interpolate` also handles MULTI-number strings: `interpolate(5, [0,10], ["0% 0%", "1.5% 1%"])`
→ `"0.75% 0.5%"`. Handy for `translate`.

**2. A whole-video fade on LOOPED audio needs `loopVolumeCurveBehavior="extend"`.**
`<Loop durationInFrames={N}><Audio volume={(f)=>…}/></Loop>`: by default (`"repeat"`) the
callback's `f` RESETS every iteration, so a tail fade ducks the bed at the end of every
single loop. Under `"extend"`, `useFrameForVolumeProp` adds
`loop.durationInFrames * loop.iteration`, making `f` a COMPOSITION frame.

**3. `<Loop>` fills its parent automatically.** `maxTimes = Math.ceil(compDuration / durationInFrames)`
where `compDuration` comes from `useVideoConfig()` — so at composition root, `<Loop>` is
coverage AND trim in one construct. No `times` arithmetic needed.

**4. `<OffthreadVideo>` will not accept a still image.** Feeding a PNG to it fails with
`Compositor error: No frame found at position N`. A test needing a real video asset can
manufacture one by rendering a throwaway composition with `renderMedia({codec:"h264"})`.
