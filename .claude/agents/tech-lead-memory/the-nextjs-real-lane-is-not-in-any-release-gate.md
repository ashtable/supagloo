---
name: the-nextjs-real-lane-is-not-in-any-release-gate
description: Three DETERMINISTIC breaks accumulated in the nextjs real e2e lane across six days and four releases because nothing runs it — each was introduced by a commit that updated the unit tests and not this lane, and each dated to a different day
metadata:
  type: constraint
---

The 2026-07-31 post-release sweep found 7 failures. Classified by re-running: **3 were
flaky** (passed on re-run, not reproducible) and **4 were deterministic** — and the four
had been red for *days*, each since a different commit:

| case | red since | introduced by |
|---|---|---|
| `E-RNP1b` | **2026-07-25** | api `f441639` added `awaitInstallationVisibility`, which the test harness's classic PAT cannot satisfy |
| `E-MC3` | **2026-07-28 23:15** | nextjs `71e32a9` moved `DEFAULT_GENERATION_PROVIDERS.image` to `gloo` and updated only the UNIT tests |
| `E-YV4` | upstream, ~2026-07-31 | YouVersion licensed a Bible for `aab`, the spec's hardcoded "zero-bible" fixture |
| `E-MC4` | upstream, gradual | OpenRouter catalogue order moved an unpriced model to position 0 |

Four releases shipped in that window. **None of them ran this lane**, and the sweep that
found all four was ad hoc. `docs/release-gate.md` §2 runs ROOT's e2e, which does not
include any nextjs spec.

## The pattern worth recognising

Three of the four were introduced by a commit whose message shows real care — `71e32a9`
lists its live measurements and says it was found "by driving the deployed studio
inspector" — and which updated `lib/api/ai-config.test.ts` and `lib/studio/ai-settings.test.ts`
while leaving `tests/e2e/studio-model-cost.e2e.ts` asserting the old default. The unit
lane runs in seconds on every push; the real lane costs a browser, a Compose stack, real
GitHub repos and ~14 minutes. **The cheap lane is the one that gets run, so the expensive
lane is where the rot accumulates** — and it accumulates *silently*, because a lane nobody
runs reports nothing at all rather than reporting red.

## What follows from it

- **After moving any DEFAULT, grep `tests/e2e/` for the old value.** A default is asserted
  in more places than the module that defines it, and the real lane is the copy that will
  not tell you for a week.
- **Treat "the real lane is green" as a claim with a date on it.** It decays. When a sweep
  finds N failures, the first question is *how long has each been red*, not *what did the
  last change break* — the answers differed for every one of these four.
- A sweep's failures are **not** one incident. These four had four unrelated causes across
  two repos and two external providers, and the flaky three had none of them.

Related: [[real-github-e2e-harness]],
[[create-repo-visibility-gate-needs-a-user-to-server-token]],
[[openrouter-pricing-image-is-input-not-output]],
[[youversion-star-catalogue-has-a-stale-cache-variant]],
[[a-silent-return-is-a-green-test-that-never-ran]].
