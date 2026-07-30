---
name: clear-derived-selection-on-effect-rerun
description: "A staleness guard placed inside an effect's early return only fires when the input goes FALSY — non-null→non-null input changes skip it entirely and leave the previously reported value armed downstream; clear unconditionally at the top of the effect instead"
metadata:
  type: convention
---

**Put the "the previous answer is no longer an answer about this input" clear at the TOP of the
effect, unconditionally — never inside the effect's `if (!input) { … return; }` branch.**

The shipped bug (nextjs `scripture-step.tsx`, fixed 2026-07-30 at `2596e64`): the wizard's
passage effect called `onSelect(null)` only inside
`if (!bibleId || !requestPassageId) { setPassage(undefined); onSelect(null); return; }`. That
branch is reachable only when the derived input becomes **falsy**, which happened for a **book**
change (`setChapters(undefined)` drove `chapterPassageId` to `null`) and never for a **chapter**
or **verse** change, where one non-null provider-issued id is simply replaced by another. For
those, `onSelect` was not called at all until the new fetch resolved, so the parent kept the
previous passage — and `canScaffold` reads exactly that value, so Create stayed armed on the
passage the user had navigated away from and the manifest committed it.

**Why nothing else could have guarded it.** The parent held no pending flag, the chip tray had
no `disabled`, and `canScaffold` reads the very value that goes stale, so it cannot be its own
guard. React batching does not close the window either — the fetch is a real BFF round trip, so
`onSelect.mock.calls` is `[]` across the whole in-flight period.

**The shape of the fix generalises.** An effect's dependency list *is* the complete statement of
what the reported value is about. So the clear belongs on the re-run path, where it covers every
input change **by construction**, rather than in a branch or a handler where cases have to be
**enumerated** — the enumeration is what was one short. It also upgrades the neighbouring
resolve-then-report invariant from "true of the first resolve" to "true on every run".

**Testing it needs a held-open fetch, and a fixture that changes non-null→non-null.** Mock the
fetcher to return a never-resolving promise for *every* call after the change (not just the
next — a chapter change re-asks twice: the chapter's own id while the verse list loads, then the
join the freshly-defaulted range produces), then assert `toHaveBeenLastCalledWith(null)`.

**Adding an intermediate `null` report is usually zero-churn** if existing assertions use
`toHaveBeenLastCalledWith` / `.calls.at(-1)` / `not.toHaveBeenCalledWith` rather than call
counts — measured here as zero churn across 1328 tests. It can also make an e2e helper's
readiness signal *stronger*: root's acquisition helper waits for the passage preview, and the
preview is now cleared in the same commit as the report, so "preview present" and "a passage is
reported" became lockstep instead of merely correlated.

Related: [[session-resolved-vs-signed-out]] (derive at render, never decide in the handler),
[[wizard-passage-must-travel-as-usfm]], [[e2e-cascade-select-needs-the-option-not-the-element]].
