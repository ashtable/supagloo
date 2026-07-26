---
name: a-test-that-claims-a-class-must-drive-the-class
description: Four ways a test in this repo asserted a whole class while driving one member of it — a hardcoded field, a corpus filtered by the predicate under test, an expectation read from the implementation, and a global assumption about every other spec's fixtures.
metadata:
  type: convention
---

Collected 2026-07-26 in `/Users/ash/code/supagloo-nodejs-api` while closing the gallery audit's
second round. All four were found by RUNNING things, and three of them were in tests written
during that same pass.

## 1. A hardcoded field inside a loop over the other fields

`gallery.e2e.ts`'s forged-cursor spec was titled "a STRUCTURALLY VALID cursor with a hostile
payload is a 400 … never an unauthenticated 500". Eleven payloads, varying `k`, `t` and `n` —
every one of them with `i: "zzz"`. The cursor's fourth field was an unauthenticated 500 on all
three sorts.

**The fix is a matrix, plus a self-check that the matrix covers what it claims:** the field names
exercised are compared against the field names the REAL codec returns for a valid cursor, so a
new cursor field that nobody adds to the test FAILS the test instead of going untested.

## 2. A corpus filtered by the very predicate under test

The replacement unit test built its hostile list as
`[...allControlChars].filter(v => !isPostgresSafeText(v))`. Run against a deliberately permissive
stub, `isPostgresSafeText` returned `true` for everything, the list came out **empty**, the loop
executed zero times and the test **passed vacuously** in the red phase.

**Enumerate the corpus literally** (`C0_AND_DEL` minus a LITERAL `[0x09, 0x0a, 0x0d]`), assert
its LENGTH, and only then cross-check that the predicate agrees with it. Same rule for the
expected outcome: read it from a literal set, never from the module's own exported constant.

## 3. An expectation that demands 400 where the contract says 200

The first cursor matrix demanded 400 for every cell and was WRONG in two ways the contract
actually specifies:
- `k: 42` is a **valid** `popular` key (an integer inside int4) and a valid `trending` key (a
  finite double) — hostile only under `newest`;
- `t` is read ONLY under `trending` (`decodeCursor` never looks at `c.t` for the column sorts and
  drops it), so a hostile `t` on a `popular` cursor is **ignored**, like any unknown JSON field.

Likewise a `:id` of `%09` is a **404, not a 400** — tab is one of the three exempt characters, so
it is safe text and reaches the database.

**The shape that works is two layers:** (a) the INVARIANT over the whole cross product — never a
5xx, never an internal detail on the wire; (b) exact status only over the cells that are
unambiguously hostile. Layer (a) is what covers the legitimately-200 cells, and it is the
property the audit was about. Add a **positive control first** (the all-valid input must be 200),
or the whole matrix can pass because everything was rejected for an unrelated reason.

## 4. A "global" assertion that is really an assumption about other specs' fixtures

`E-G10` asserted `?q=%` returns `[]` — i.e. that no row in the WHOLE database contains a literal
`%`. It broke the moment another spec published a title containing `100%` to prove the text gate
is not over-tight. This file's own header already forbids un-scoped set assertions; these two had
slipped through. **What "`%` is a LITERAL" means is that it does not match everything**, so the
assertion is now scoped to the group's own nonce.

## And one number-hygiene rule

`renders.e2e.ts` is **non-deterministic**: three runs of IDENTICAL code gave **2, 4 and 2**
failures, and every failure was the same worker-side precondition (`project owner … has no
GitHub installation — cannot clone`). Two successive reports quoted contradictory counts for it
(`4→3`, then `5 failed / 2 passed at both commits`) — both were reporting noise as measurement.
**Never quote a pass/fail count from this suite as evidence of anything.** To show a change did
not break it, show the FAILURE REASONS are unchanged and that the change's own gate never fired
(grep the output for the gate's message).

Related: [[tests-that-hold-invariants-vs-shapes]], [[one-rule-one-module-many-boundaries]],
[[vite-cache-poisons-mutation-testing]].
