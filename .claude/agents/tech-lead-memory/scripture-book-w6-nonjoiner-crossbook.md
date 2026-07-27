---
name: scripture-book-w6-nonjoiner-crossbook
description: CLOSED 2026-07-26 at db-lib b13b846 — the scriptureBook deriver answered the SECOND book when an unenumerated separator sat between two books ("Genesis: Exodus 1:1" -> EXO); fixed by generalizing the joiner NOTION, with all three candidate fixes priced
metadata:
  type: decision
---

**W6 — CLOSED at db-lib `b13b846` (2026-07-26); it was OPEN at `657234b`.** The last known
mis-file class in `supagloo-database-lib/src/scripture-book.ts`. A chapter-free first book
followed by a separator that form (c) did not enumerate failed the shape rule, so
`scanForBook` walked PAST it and the SECOND book answered — the one outcome the module says
it must never produce. Measured at `657234b` over 1,093,592 two-book frames: **642,339
answered a book that was not the first one named.**

Members (all EXO before the fix): `:` `or` `vs` `(` `|` `+` `!` `?` — plus three the original
report missed and this pass found: a plain **SPACE** (`"Genesis Exodus 1:1"`), a **compound**
separator (`"Genesis, and Exodus 1:1"`), and the **chapter-bearing** form
(`"Psalm 23 | John 3:16"` -> JHN, where only the space spelling had been fixed by W5's
following-BOOK terminator). The subtlest member came through `skipPossessive`:
`"Genesis'Song of Solomon 1:1"` -> SNG, because the unconditional `'S` skip ate the `S` of
`SONG` and started the form-(c) chain mid-word.

**THE FIX — widen the NOTION, do not enumerate members.** `JOINER_RE` is now
`/^(?:[^A-Z0-9]|(?:AND|TO|OR|VS|THROUGH)(?![A-Z0-9]))+/`: between two book phrases, any run
of characters carrying no ASCII letter or digit joins them (a plain space included), plus
five whole words. **The argument that makes it safe is positional** — verse punctuation lives
between a NUMBER and a NUMBER, so nothing standing between two BOOK PHRASES can be verse
punctuation, and that is the only position this regex is ever asked about. It retires the
module's old claim that "`:` is deliberately NOT a joiner". Two edits fall out of it: `'S`
must now END a token (mirroring `endsAtTokenBoundary`; a digit after it is still fine,
`"Psalm's23"`), and `joinsAnotherSegment` narrows the notion in exactly ONE position — onto
another BOOK anything joins, onto another NUMBER a run of plain spaces does not, or
`"Job 30 000"` derives JOB and `"Psalm 23 2024"` derives PSA.

**Sweep of the built module against the `657234b` build, 1,736,925 probes:** 638,959 answers
moved to the FIRST book named, **0** moved to a later book, **0** became null, 1,435
chapter-range spellings (`"Psalm 23 : 2"`) became non-null, CROSS-BOOK **642,339 -> 0**. The
515 string literals of the pre-existing test file changed in exactly 5 places — all five the
W6 strings quoted in the comment that documented the defect, i.e. no pinned expectation moved.

**THE THREE CANDIDATES, PRICED — do not re-litigate without these numbers:**
- *(A) add `:` and friends to the character class* — closes 312,785 frames but leaves 329,559
  cross-book: the space, compound and `'S` members stay broken. Treats members, not the class.
- *(B) a matched-but-REJECTED phrase blocks any later book (return null)* — measurably the
  worst of the three. Over the 27,552-probe prose-lead-in family it **nulls 24,108 correct
  answers and keeps 3,385 of the 3,385 wrong ones**, because the survivors are exactly the
  cases where the lead-in phrase was ACCEPTED. `"A song about Genesis 1:1"` and
  `"My favourite psalm is Psalm 23"` both go null. (Its usual defence — "the walk-past rule is
  what makes `"Read Genesis 1:1, Exodus 2:2"` -> GEN work" — is wrong: READ is not a book
  phrase, so nothing is rejected there.)
- *(C, shipped) widen the joiner notion* — 0 cross-book, 0 code->null.

**THE RESIDUAL, pinned as a DECISION in U-SB7g — not a defect, do not file it as W7:** an
UNLISTED WORD between two books does not join them, so `"Genesis then Exodus 1:1"` and
`"Genesis thru Exodus 1:1"` are EXO, and `"1 John thru John 5:1"` is JHN. That is the SAME
mechanism that keeps `"A song about Genesis 1:1"` answering GEN, and an English connector
vocabulary is not something this module owns — the same line it already draws for chapter
terminators. A second, hostile 1,457,970-probe sweep found no other residual: every remaining
non-first-book answer has an unlisted word as its separator (or a letter glued onto the first
book, `"GENESISs EXODUS 1:1"`), and every one is identical to the pre-fix build.

**Method notes worth reusing:**
- The WORD half of a joiner set can never be closed (any word could be a joiner), so it is
  enumerated on purpose; `THRU` is deliberately out. Only the PUNCTUATION half can be made
  general — and it is the half that had all the volume.
- **A pin can silently stop pinning when a rule generalizes.** The typographic-dash fold's
  isolator went green-without-the-fold once any punctuation joined, and had to be re-anchored
  from "a dash used as a JOINER" to "a dash used as a CHAPTER TERMINATOR" (`"Psalm 23–KJV"`).
  Re-check every existing pin's isolator after a widening, not just that the suite is green.
- Widening a joiner can only move an answer EARLIER in the string or from null to a code; it
  can never make a LATER book win. That is why (C) needed no cross-book search, only a
  prose-precision one.

Related: [[scripture-book-reference-shape-rule]],
[[scripture-book-mutation-audit-inert-guards]], [[generated-frame-sweep-beats-unit-tests]],
[[vite-cache-poisons-mutation-testing]].
