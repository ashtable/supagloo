---
name: a-permissive-default-opens-a-second-doorway
description: Gating only the "blocked" branch of a guardrail is always a half fix when the same evaluator deliberately verdicts ALLOWED on an unresolved read — the unresolved window routes straight past the gate into the thing you were protecting against
metadata:
  type: constraint
---

Found 2026-07-31 while implementing revision R3 of the optional-connections review.
Neither independent judge caught it; the shipped one-liner would have closed one of two
doorways and a composition test written only against the blocked case would have gone
green over the survivor.

## The shape

`evaluateConnectionGuardrail` (`lib/workspace/connection-guardrail.ts`) returns
`kind: "allowed"` while `resolved === false` — deliberate, documented, pinned by `U-GR5`
(a failed or pending read is not an answer about the user's data; see
[[a-failed-read-is-not-an-answer-about-the-user-s-data]]). `connectionsResolved` is false
until the real-mode fetch lands.

`WorkspaceHome` rendered three things off that verdict:

```
{wizardRequested && blocked   && <ConnectionsRequiredModal/>}   ← the reported bug
{wizard === "new"  && !blocked && <NewProjectWizard/>}          ← the survivor
{wizard === "import" && !blocked && <ImportWizard/>}            ← the survivor
```

The review's fix was `&& !firstSignIn` on the first line. But on **every** first mount at
`?newproject=blank`, before `GET /api/connections` answers, `blocked` is FALSE — so the
modal never rendered there anyway and the fix was inert, while `<NewProjectWizard/>`
rendered over `<SetupWizard/>` and produced the identical harm (two portalled dialogs at a
user with no live GitHub data and no designed empty state).

## The rule

**When a guard's evaluator has a deliberate permissive default, the `!blocked` branches are
part of the guard's blast radius, not the safe complement of it.** Gate the whole family
behind ONE derived predicate at the point they converge — here `const launcherLive =
!firstSignIn;` on all three — never a copy per element.

## What makes a test able to see it

Three cases, and the third is what makes the first two mean anything:

1. `firstSignIn` + **resolved** + unconnected → the blocked doorway;
2. `firstSignIn` + **UNRESOLVED** → the permissive doorway (the one that survives a
   half fix);
3. **CONTROL** — not `firstSignIn`, unconnected, resolved → the modal DOES render and
   `push` DOES fire. Without it the suite cannot distinguish "gated correctly" from
   "gated always", and `launcherLive = false` passes.

Mutation-verified both directions: `= true` kills 5/6, `= false` kills 4/6.

## Stubs in a composition test must render, never `null`

`tests/unit/workspace-grid-gating.test.tsx` structurally could not host any of this: it
mocks `SetupWizard` to `null` (killing the element under observation) and its `useRouter`
mock mints a fresh `vi.fn()` per call (so `push` is unassertable). `vi.mock` is file-level
hoisted, so neither is fixable with a second `describe` — it needed a NEW file
(`tests/unit/workspace-guardrail-composition.test.tsx`). A `null` stub makes "rendered" and
"did not render" indistinguishable, which is exactly how the sibling file lost the ability
to see this.

Related: [[optional-connections-built]], [[session-resolved-vs-signed-out]],
[[one-rule-one-module-many-boundaries]], [[tests-that-hold-invariants-vs-shapes]].
