---
name: publish-to-gallery-dialog-built
description: Turn 16b's one publish dialog — the key= reset that had to move, the client-side D8 join, why the api's refusal must survive the fetch layer, and where a publishing e2e gets a publishable render
metadata:
  type: decision
---

Slices C8/C9 (2026-07-26) replaced BOTH publish placeholders with one 560px dialog
(`supagloo-nextjs/app/_components/gallery/publish-to-gallery-dialog.tsx`) and built 17b
card 4a's empty state. Five things worth keeping.

**1. A `key=`-based reset does not survive being generalised — it has to be re-aimed.**
The old `PublishDialog` was keyed on "which render did the page open me with". 16b lets
the user change that choice *inside* the dialog, so the key moved to
`<PublishBody key={selectedRenderId}>`, with only `selectedRenderId` lifted out. The
layout could not be keyed directly (the toggles/consent/actions sit below the flex row
that holds the picker), so the whole body — picker included — became the keyed child and
the parent owns nothing but the selection.
**Why:** the state being protected is `scriptureReference`, which the server derives
`scriptureBook` from *and* which prints verbatim on a public card. A leak publishes B
under A's passage.
**Trade-off:** two keys now exist for one rule — the page's `key={publishing.id}` and the
dialog's. Both needed a test; see [[a-guard-only-reachable-by-an-unusual-path]].

**2. `PROJECT ▾` is a client-side join, not a new wire field.** `psalm-121 · v0.0.2` needs
`Project.slug` × `ProjectVersion.semver` × `RenderJob`, and no endpoint carries the three
together. `lib/gallery/publish-options.ts` joins them over reads that already exist (one
`/versions` call per **distinct** project, not per render). **The rule that matters: a
publishable render is never dropped because a join missed** — an unresolved side degrades
to the id (`<projectId> · unknown version`). Hiding a finished video because a naming call
failed is a far worse lie than an ugly label.
**Known smell:** a project with N renders yields N identically-labelled options. Recorded
as a gap, not fixed — the design assumes one render per project.

**3. The publish call is the one mutating fetch that must NOT collapse to `null`.**
`publishRenderToGallery` now returns `{ok:true,item} | {ok:false,message}`. The api emits
three individually-actionable refusals (`already_published`,
`render_not_publishable`, `scripture_book_underivable`) and the BFF passes status + body
through verbatim; flattening them into "that didn't publish" throws away the only thing
that tells the user what to do. Falls back to the machine code, then to a house sentence.

**4. Divergences from the drawing, all deliberate.** Consent ships **unchecked** and gates
submit (drawn pre-ticked = an agreement nobody made; the disabled-submit state is
invented). `community guidelines` is bold text, not a link — no such page exists.
`Allow remixes` / `Show my GitHub repo` / `Change cover frame` ship **visibly disabled
with a tooltip** (never a control that silently does nothing, and never a drawn control
silently deleted). No DESCRIPTION field (D12) but `description: ""` still on the wire. The
cover shows the render's REAL thumbnail and no burned-in caption — the renderer already
burned one into the frame.

**5. Manifest prefill is non-blocking AND narrower than "use scene 1".**
`manifestPrefill` only prefills `PASSAGE` when **every** scene names the same reference
(same rule for translation). Scene 1's `Psalm 23:1` for a video covering 23:1–6 would
prefill a passage narrower than the video — into the field the public card prints. Blank
beats wrong. The read is fired non-blocking on selection so a GitHub round-trip never
sits in front of a dialog open.

17b card 4a (`gallery-grid.tsx`) departs from the drawing twice: no `GALLERY · NO RESULTS`
header strip (that eyebrow is the 17b spec sheet's label for the card, not page chrome),
and `Clear filters` renders only when a filter is actually set. `onClearFilters` must
clear the search **box** as well as the committed query — the box is debounced *into* the
query, so clearing one half re-commits the same term 250 ms later.

Related: [[gallery-watch-page-built]], [[gallery-ui-built]],
[[a-spec-that-writes-to-a-global-surface-owes-teardown]].
