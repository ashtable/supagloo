---
name: modal-panel-is-viewport-bounded
description: The shared `Modal` caps its panel at the viewport and scrolls its BODY — before that, any dialog taller than the screen put its action row permanently off-screen on a phone, because a fixed backdrop is not something the page can scroll to
metadata:
  type: convention
---

`app/_components/modal.tsx` paints into a `position: fixed` backdrop. A panel taller than
the viewport therefore overflows something **nothing can scroll**: the document behind it
is not what is overflowing, so the page scrollbar cannot reach it. Whatever sits at the
bottom of the panel is unreachable — the 16b publish dialog's whole Publish/Cancel row
was off-screen at 375×667, and the ✕ measured `top: -114.6px`. The dialog could be
filled in and never submitted.

The recipe (2026-07-26), three parts, all load-bearing:

1. `maxHeight: calc(100vh - 48px)` on the panel + `display:flex; flexDirection:column`,
   so the cap is shared between a fixed header and an elastic body;
2. `minHeight: 0` on the body — a flex child defaults to `min-height: auto` and refuses
   to shrink below its content, which silently defeats the cap;
3. `overflowY: auto` on the BACKDROP plus `margin: auto` on the panel **instead of**
   `alignItems: center`. `100vh` is not always the visible height (mobile browser
   chrome), so the cap alone can still leave a panel taller than the viewer can see; a
   centered flex item overflows equally in both directions and puts its TOP out of
   reach, while `margin: auto` centers when there is room and stays reachable when there
   is not.

The header is `flex: none`, so `modal-close` stays put while the body moves. A modal that
draws its OWN chrome inside `children` (both wizards) scrolls that chrome with the
content — the deliberate trade for one rule here rather than a header slot every consumer
opts into.

**Proving it needs a browser and hit-testing, not geometry.** `E-GP8` in
`gallery-watch.e2e.ts` drives 375×667 / 390×664 / 360×640, calls `scrollIntoView`, then
requires `document.elementFromPoint` at the button's own centre to return
`publish-submit` — a geometry-only assertion passes for a button sitting under the scrim.
It restores the viewport in a `finally`; the lane shares one browser.

Related: [[gallery-ui-built]], [[publish-to-gallery-dialog-built]].
