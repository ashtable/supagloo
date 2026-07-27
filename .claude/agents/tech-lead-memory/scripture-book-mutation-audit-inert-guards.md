---
name: scripture-book-mutation-audit-inert-guards
description: the 11 guards in db-lib's scripture-book.ts that survive the test suite AND provably cannot change any answer — do not "fix the coverage gap", and do not delete them either
metadata:
  type: reference
---

A 73-mutation audit of `supagloo-database-lib/src/scripture-book.ts` (2026-07-26, landed at
`657234b`) deleted or widened every accept/reject rule and guard one at a time. 46 were
already killed by the suite, 15 were genuinely unpinned and got pins (U-SB7f), 1 was a real
defect ([[scripture-book-w6-nonjoiner-crossbook]], since CLOSED at `b13b846`) — and **11
survive the suite while making zero behavioural difference: 0 differing answers over a
253,462-string differential frame space.** They are NOT coverage gaps and cannot be pinned
behaviourally:

- `isOrdinalTail`'s `start < 2`, preceding-SPACE and preceding-DIGIT checks — all three are
  implied by the `PHRASE_SET.has(...)` test that follows, because every multi-token match
  phrase has the shape `<digit> <name>`.
- `bookPhraseAt`'s length-overrun guard and `joinsAnotherReference`'s memo — pure performance
  (`String.startsWith` past the end is already false; the memo only avoids re-walking a suffix
  whose verdict is a property of that suffix).
- `MATCH_PHRASES` first-claimant-wins and its code/name/alias priority order — inert **because**
  U-SB1's expanded-variant collision guard holds. With no variant claimed by two books, claim
  order cannot change any code. If that guard ever goes, these two become live.
- `NUMERIC_PREFIX_RE`'s `III|II|I` alternation order (the trailing `(?![A-Z0-9])` already forces
  the longest), `scanForBook`'s non-committing inner loop (no phrase pair in today's table has a
  shorter member accepted where the longer is rejected — the module comment's
  `"Song of Songs 1:1"` example does not actually isolate it, since longest-first tries the
  13-char phrase first), `deriveScriptureBook`'s empty-string early return (the scan loop is a
  no-op on `""`), and `isScriptureBookCode`'s `typeof` guard (`Set.has` of a non-string is false).

**A TWELFTH, added by W6's fix (2026-07-26, `b13b846`):** `joinsAnotherSegment`'s CLAUSE
ORDER. Applying its space-narrowing to the BOOK branch as well as the number branch changes
nothing — 0 differing answers over 483,937 direct probes — because a space-then-BOOK tail is
independently accepted by the following-BOOK rule at the end of `hasChapterTail`. The order is
kept as written because "onto a book anything joins, onto a number it does not" is the rule and
the code should read as the rule. (This was the only survivor of 11 mutations of W6's new
rules; the other 10 are red.)

**Method notes worth reusing:** run the mutation against the ONE test file
(`npx vitest run src/scripture-book.test.ts`, ~220ms) and `rm -rf node_modules/.vite` before
every run — see [[vite-cache-poisons-mutation-testing]]. For "is this survivor inert or just
untested", compile the mutant with `npx tsc` into a temp file and diff its answers against
HEAD's over a generated frame space; the suite alone cannot tell those two apart.
