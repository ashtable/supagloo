---
name: tests-that-hold-invariants-vs-shapes
description: Three ways the gallery suite passed while the thing it claimed to prove was unheld — an un-tested "non-negotiable" rule, a mock-shape assertion mistaken for behaviour, and a real-app carve-out pinned only against a fake — and the fix pattern for each.
metadata:
  type: convention
---

From the 2026-07-26 adversarial audit of `supagloo-nodejs-api` rows 39/40 (commit `d319046`,
79 unit + 25 e2e green). The security core was genuinely sound, and three *proof* claims were not.
Each failure mode recurs, so each has a named fix pattern.

## 1. A comment calling a rule "non-negotiable" is not a test

`gallery-query.ts`'s header declared three safety rules, #1 being that the ORDER BY key comes from a
fixed map and is "never built from the request string". Mutating `ORDER BY "sortKey"` into
`ORDER BY ${Prisma.raw(String(rawOrder))}` — the request's `sort` interpolated into SQL text — left
**79/79 unit and 25/25 e2e green**. The existing injection test only drove a hostile `q` and a
hostile cursor `i`, and neither of those can see the ORDER BY clause.

**Pattern:** every rule a module header calls load-bearing must NAME the test id that holds it, and
that test must fail under the obvious mutation. For SQL text the assertions that bite are (a) the
ordering key is a FIXED alias present verbatim, and (b) no value of the request enum appears
anywhere in the static SQL. An out-of-enum-sort probe alone does NOT bite: the fixed-map lookup
throws first, so the mutation never emits anything.

## 2. A mock-shape assertion is not a behavioural proof

`upvote`'s doc-comment claimed the obvious `try { create } catch (P2002) {}` shape was BROKEN.
Measured: it is not. Only **swallow-then-increment-unconditionally** breaks (25P02 out of the
increment on an aborted transaction). Both a catch that also skips the increment and
check-then-insert are correct, and the e2e cannot distinguish either from the shipped
`createMany({ skipDuplicates })`. The e2e case even carried the label "THE
P2002-IN-A-TRANSACTION PROOF".

**Pattern:** when no behavioural test can distinguish your choice from a correct alternative, say
so in the comment and name what actually pins it (here: shape assertions, plus the *reasons* — the
abort becomes structurally unreachable rather than contingent on nobody adding a statement after
the catch, and one round trip instead of two). Then add the behavioural pin that IS possible: a fake
that models the hazard. `U-UV11` gives the fake transaction a unique constraint and Postgres's abort
semantics (every op after a conflict throws 25P02), which goes red on the broken shape and green on
all three correct ones — honest, exact, and a unit test instead of an 8-request burst.

## 3. A carve-out proven only against a fake auth service is not proven

`optionalAuth`'s degrade (present-but-invalid token ⇒ 200 anonymous, never 401) is the one auth
carve-out on the gallery surface. Mutating it to 401 was caught by three unit tests and the gallery
e2e stayed **25/25 GREEN** — nothing ever sent a bad bearer to the real app. That is the behaviour a
user with a stale cookie actually gets.

**Pattern:** any auth SHAPE that differs from the default needs one real-app e2e case, and it must
assert both halves — the degrade AND that the same token is still a hard 401 on every route that
needs a session. Otherwise the carve-out is indistinguishable from a hole.

## 4. And the meta-lesson about hostile-input tests

The forged-cursor loops used `["zzz","","e30","%%%"]` and `"last tuesday"` — inputs that all die at
the base64 / JSON / shape gates, or at the one string V8 also rejects. **No test ever sent a
STRUCTURALLY VALID payload with hostile CONTENTS.** Hostile-input tests have to get PAST the outer
gates to test the inner ones. See [[bound-is-not-safe-postgres-value-gates]] for what was hiding
behind them.

Related: [[gallery-backend-built]], [[vite-cache-poisons-mutation-testing]] (always
`rm -rf node_modules/.vite` between mutate → run → restore, or the mutation results are fiction).
