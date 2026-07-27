---
name: a-guard-only-reachable-by-an-unusual-path
description: A surviving mutation showed a key= guard whose only distinguishing path was A→B with no close in between; also why a semantic extract must never be asked to COUNT
metadata:
  type: convention
---

Two findings from slice C8's verification pass (2026-07-26), both about tests that looked
sufficient and were not.

**A guard whose distinguishing path no test takes is untested, even with five green tests
around it.** `your-videos-list.tsx` mounts the publish dialog conditionally
(`{publishing && <Dialog key={publishing.id} …>}`). Replacing that `key` with a constant
left Y-VL1–Y-VL3 **green**, because all three close the dialog between opens and the
conditional mount already unmounts it on close. The key only earns its place on the one
transition none of them made: **A → B with no close in between.**

That transition is reachable — the rows stay in the document behind the portalled modal,
so a keyboard user tabbing past the focus trap, a screen reader, or any future layout
where the overlay stops covering the grid can hit it. `Y-VL4` now drives it, and the
mutation dies.

**Method:** when a mutation survives, the question is not "is this test weak" but "what
is the *only* input under which the mutant and the original differ" — then write that
input. If no such input exists, the guard is genuinely redundant and should be deleted
instead (see the 11 inert guards in [[scripture-book-mutation-audit-inert-guards]]).

---

**Never ask a `stagehand.extract` to COUNT things.** `E-GW8` asked the model for "how many
distinct videos are playable on this page" alongside three genuinely semantic reads
(title / creator / passage). Two back-to-back runs against a byte-identical page answered
`1` and then `4`. The `4` was not a defect in the page; it is what happens when a model is
asked to enumerate DOM objects.

The rule: an `extract` may only be asked what a selector *cannot* answer — which string a
reader would identify as "the title", whether a page reads as one thing or another.
Cardinality, presence and attribute values are structural, and a deterministic
`countTestId` does them perfectly and cannot flake. E-GW8 keeps the three semantic reads
and asserts the counts deterministically underneath.

**Corollary from the same run:** `E-GW4` asserted the `m:ss` timecode changed immediately
after `currentTime > 0`. The seeded fixture mp4 is **one second** long, so the readout
legitimately stays `0:00 / 0:01` until playback crosses the half-second rounding boundary
— a race the fixture usually won. Fixed by polling the sub-second scrub-fill width (the
honest "the transport tracks the element" claim at this scale) *and* polling the timecode
to a deadline. **Match the assertion's resolution to the fixture's.**

Related: [[gallery-e2e-seed-helper]] (why the fixture video is 1 s),
[[tests-that-hold-invariants-vs-shapes]].
