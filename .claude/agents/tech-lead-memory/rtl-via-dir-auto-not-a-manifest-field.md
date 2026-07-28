---
name: rtl-via-dir-auto-not-a-manifest-field
description: RTL scripture is honoured with dir="auto" in the editor, the preview AND the generated Remotion source — no language/direction field on ManifestScene, because dir="auto" is a standardised algorithm (UAX#9 first-strong) that every browser engine implements identically, so the preview (the user's browser) and the render (headless Chromium) agree without being the same engine
metadata:
  type: decision
---

Task item 1 (2026-07-27) needed non-English scripture to render correctly. The obvious
design — a `language` or `direction` field on `ManifestScene` — was **rejected**.

**Chosen: `dir="auto"` on the caption and the reference, in every place the text appears.**

| Where | File |
|---|---|
| the editor's Script textarea | `supagloo-nextjs/app/studio/_components/scene-inspector.tsx` |
| the preview caption + reference | `supagloo-nextjs/app/studio/_components/storyboard-video.tsx` |
| the GENERATED Remotion scene source | `supagloo-nodejs-dbos/src/remotion/templates.ts` (both `<p>`s) |

**Why it beats a manifest field, not just why it is cheaper.** `dir="auto"` is the HTML
standard's bidi first-strong-character determination (UAX#9 P2/P3) — a **specified
algorithm, implemented identically by every browser engine**. The studio preview runs
`@remotion/player` in the **user's** browser (which may be Safari or Firefox); the render
runs `@remotion/renderer` in headless Chromium. They are **not** the same engine, and they
do not need to be: what makes the preview and the MP4 agree is the standard, not a shared
engine. (An earlier version of this note claimed they were the same engine. That was
false — corrected 2026-07-28. The conclusion is unchanged; only its justification was
wrong, and no code moved.) That is the failure mode that matters
here; a hand-plumbed field would have had to be kept correct across four mirrors
(db-lib `ManifestSceneSchema`, nextjs `lib/api/contracts.ts`, `manifest-json.ts`'s
`canonicalizeManifest`, `templates.ts`) plus the UI `Scene` and the adapter both ways, and a
db-lib release, to reach the same place. **Trade-off, stated:** a scene whose script *begins*
with a Latin word but continues in Arabic resolves LTR — the standard's own answer.

It matters most on the REFERENCE line: YouVersion's reference strings for RTL translations
arrive pre-marked with **U+200E LEFT-TO-RIGHT MARK** around the numerals (`التكوين ‎1:1`).
Do not strip or re-format them.

Three companion details:

- **Logical properties, not physical.** The inspector's quote rule was
  `borderLeft`/`paddingLeft`; under RTL that lands on the TRAILING edge. Now
  `borderInlineStart`/`paddingInlineStart`. (jsdom's `style.borderLeft` reads `"medium"`
  when unset, so assert on the inline `style` ATTRIBUTE text, not the property.)
- **The italic override is CSS, not JS.** `.scriptInput:dir(rtl) { font-style: normal }` in
  `app/studio/studio.module.css` — Arabic and Hebrew have no true italic forms and browsers
  synthesise a slant that reads as broken (16a already sets quoted scripture upright, so
  there is an in-design precedent). Doing it with `:dir()` means **no hand-written script
  detector exists anywhere** — the platform's bidi algorithm is the single source of that
  answer in all three places.
- **`textAlign: "center"` stays.** Centring is direction-neutral; `dir` is only fixing
  punctuation placement and mixed-content ordering.

Cost in the render generator: the two byte-for-byte goldens
(`src/remotion/__golden__/shelter/src/scenes/{Shelter,Refuge}.tsx.golden`) gain exactly 4
lines. There is **no `UPDATE_GOLDEN` mechanism** — hand-edit them in the same commit as the
template change, and back them with a BEHAVIOURAL assertion (`generate.test.ts` U-T-DIR1/2)
so a future edit cannot delete the attribute and "fix" the golden.

Related: [[youversion-bible-read-surface-lives-in-nextjs]],
[[remotion-template-generator-built]], [[remotion-css-and-loop-gotchas]].
