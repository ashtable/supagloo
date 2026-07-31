---
name: two-entry-points-disagree-about-the-opening-scene
description: E-SH2 reported silent data loss on its first-ever execution; the edit was in git the whole time — a generation selects scenes[0] and a fresh open selects scenes[1], and `script-input` had no way to say whose script it held
metadata:
  type: context
---

Found 2026-07-30, immediately after [[a-silent-return-is-a-green-test-that-never-ran]]
made `studio-hydration.e2e.ts` E-SH2 actually run. Its first real execution failed at

    expected 'And God saw the light, that it was go…' to contain 'Persisted edit ms8kh8jqapoqqs'

after 118 s, with everything before the final assertion passing — post-generation commit
clean, `data-dirty` true on the edit and false after the second commit, zero
`commit-error`. That shape reads as **silent data loss**, and the prime suspect was the
known one: `serializeManifest` builds its result field-by-field with no `...base` spread
(the four/five/seven-mirror class, [[the-manifest-has-five-mirrors-not-four]]).

**It was not data loss.** The edit reached the repo.

## The two selection entry points, both deliberate

| when | who | picks |
|---|---|---|
| a storyboard is (re)generated | `STORYBOARD_GENERATED` (reducer.ts) | `scenes[0]` |
| a project is opened fresh | `initialStudioState` (reducer.ts) | `scenes[1]` — the 5a wireframe's SCENE 02 |

E-SH2 edits right after a generation and then re-opens, so it crosses exactly that seam:
it typed into scene 1 and read scene 2 back. Neither pick is wrong; **assuming they agree
is**. `initialStudioState`'s scene-2 default is heavily load-bearing — mutating it to
`scenes[0]` reddens **15 tests across 7 files** — so it is not something to "fix" in
passing.

## What settled it, and the general lesson about how

Not reasoning — **git**. The e2e creates real fixture repos, so the cheapest discriminator
is reading what actually landed:
`ashtable/supagloo-e2e-delete-me-hydrate-edit-ms8kh9fca9d2d735`, branch `v0.0.1`, commit
`71cb0f5` "Update scene: The Creation of Light". Its entire `supagloo.project.json` diff
is one line — `scenes[0].scriptText` → `"Persisted edit ms8kh8jqapoqqs"` — and the string
the assertion read is `scenes[1]`'s untouched script. Two API calls, versus a day of
reading a serializer that was never at fault. **When a real-lane e2e writes to a real
system, inspect the artifact before inspecting the code.**

## The actual defect: an un-attributable read

`script-input` lives in `SceneInspector`, which exposed four attribute-only seams
(`data-visual-asset-key`, `data-scene-reference`, `data-scene-translation`,
`data-visual-asset-kind`) and **never said which scene they belonged to**. A test reading
that textarea could assert the CONTENT and never the SUBJECT — so a selection difference
and a lost commit are the same observation. Fixed by adding `data-scene-id={scene.id}`,
bound to the scene **rendered** (the panel falls back to `scenes[0]` for a selection
matching nothing) rather than to `selectedSceneId`.

Rule to carry: **an assertion about "the value shown" is only as good as the element's
ability to name its subject.** Every sibling spec that does this round trip already
selects a scene by id first (`studio-replan-scripture` E-RS1, `studio-translation-widen`,
`studio-wizard-scripture-carry`); E-SH2 was the one that had never run, so it was the one
that never learned. A spec that labels a read with the id it *intended* to select — rather
than the id the panel reports — has the same hole one level down, and
`studio-wizard-scripture-carry`'s `everySceneScripture` had it (now asserts the panel's
own id and throws on a click that did not land).

Pinned pure, no stack, ~1 ms: `tests/unit/studio-edit-round-trip.test.ts` (U-RT1 holds
"hypothesis (a) is false", U-RT3/U-RT4 hold the divergence and reproduce the failing
string verbatim) and `tests/unit/studio-scene-identity.test.tsx` (U-SI1..U-SI4, the seam).

Related: [[a-silent-return-is-a-green-test-that-never-ran]],
[[e2e-cascade-select-needs-the-option-not-the-element]] (a click is a request, not a
result), [[studio-hydration-commit-wired-nextjs]].
