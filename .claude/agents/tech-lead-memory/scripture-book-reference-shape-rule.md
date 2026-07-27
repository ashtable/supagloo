---
name: scripture-book-reference-shape-rule
description: db-lib's scriptureBook deriver — the reference-shape rule, the two rejected join rules, and the deliberate 422 on chapter-free book ranges
metadata:
  type: decision
---

`supagloo-database-lib/src/scripture-book.ts` (task 39 / plan D6) turns free-text
`scriptureReference` into a USFM book code for `GalleryItem.scriptureBook` — a NON-NULL
INTERNAL column with **no UI surface** (there is no book facet; see
[[gallery-not-filterable-by-book]]). `SCRIPTURE_BOOKS` is the set of codes the normalizer
RECOGNIZES, never a canon claim. The asymmetry that decides every question in this module
still holds: **null is a loud, client-fixable 422; a wrong code is a permanent, silent
mis-file of a public item.** Recall always loses to precision.

Because many book names/aliases are ordinary English words (`JOB`, `SONG`, `PSALM`, `HO`,
`PS`, `MT`), a match is accepted only if its tail is reference-shaped: **(a)** the phrase
opens the string and nothing alphanumeric follows, **(b)** a properly terminated chapter
number, or **(c)** a joiner onto ANOTHER REFERENCE SEGMENT — a book with its own chapter,
or a book joined onward to one (walked iteratively with a per-scan memo).

**A JOINER IS A GENERAL NOTION, not a list of characters (changed 2026-07-26, db-lib
`b13b846`, see [[scripture-book-w6-nonjoiner-crossbook]]):** any run of characters carrying
no ASCII letter or digit — a plain space included — plus the whole words `AND`/`TO`/
`THROUGH`/`OR`/`VS`. The old six-character set made the SEPARATOR decide the answer
(`"Genesis: Exodus 1:1"` -> EXO). Nothing standing between two BOOK PHRASES can be verse
punctuation, which is why the general rule is safe at that position; the narrowing is
positional and lives in `joinsAnotherSegment` (onto another NUMBER a run of plain spaces does
NOT join, or `"Job 30 000"` derives JOB).

**Why (c) is that strict — two cheaper rules were tried and REJECTED (2026-07-26):**
- *"the string contains a digit somewhere"* — still accepted `"Song and song, take 2"`,
  where the digit belongs to neither book.
- *"the joined book must be a DIFFERENT book"* — opened a strictly WORSE hole: with
  `"1 JOHN"` refused at position 0 for joining back onto itself, `"1 John and 1 John"`
  fell through to the bare `JOHN` at index 2 and answered **JHN**. That is the `"1st John"`
  cross-book family (see also `1GEN`, `x1 John`), and it is the one outcome the module
  must never produce.

**Deliberate contract change:** a CHAPTER-FREE book range no longer resolves.
`"Romans…Ephesians"` was ROM, `"Genesis - Exodus"` was GEN; both are null → publish 422s.
D6's multi-book → FIRST book still holds whenever the chain reaches a chapter, at any
depth (`"Genesis - Exodus - Leviticus 1:1"` → GEN).

**Article forms are curated ALIASES, not a `THE `-strip** (a documented deviation from
D6 step 1). The strip re-scanned the article-less string, and that second scan brought its
own position 0, so form (a) fired on it and every one-word book got a free
article-prefixed prose form (`"The Job"`, `"The Song"`, `"The Numbers"`). Five titles
across four books own the article explicitly: `THE ACTS`, `THE REVELATION`,
`THE SONG OF SOLOMON`, `THE SONG OF SONGS`, `THE PSALMS`. **The set is closed** — adding a
member re-opens a bare-form prose surface.

Pinned decisions a reader might mistake for oversights: `"PS4"` IS Psalm 4 (a
separator-less chapter is required by `GEN1:1`/`PSA23`); a WORD never terminates a chapter
so `"Psalm 23 KJV"`, `"Genesis chapter 1"`, `"Book of Genesis"` are all null (the rule that
would admit them is the rule that lets `"PS I love you"` mis-file), while
`"Psalm 119:105 ESV"` resolves because the verse punctuation terminates the number first.

Related: [[generated-frame-sweep-beats-unit-tests]], [[vite-cache-poisons-mutation-testing]]
