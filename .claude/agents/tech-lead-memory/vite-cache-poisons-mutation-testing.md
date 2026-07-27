---
name: vite-cache-poisons-mutation-testing
description: "vitest's on-disk node_modules/.vite transform cache makes rapid mutate→run→restore loops report phantom failures — rm -rf node_modules/.vite between mutations or the red/green signal is noise"
metadata:
  type: gotcha
---

**Mutation testing (apply a mutation → run the suite → `git checkout` → re-run) is untrustworthy in
these repos unless you `rm -rf node_modules/.vite` between every mutation.** vitest's on-disk
transform cache serves stale transforms of a file you have already restored.

Measured concretely (rows 39–41 run, db-lib `419bba5`, 2026-07-26): after restoring a file to be
**byte-identical to HEAD** — `git diff-index --quiet HEAD` clean, `git status --porcelain` empty —
**5 consecutive runs still failed** on a `migration.sql` assertion left over from an earlier
mutation. An auditor measured a **~29% phantom failure rate over 58 runs at pristine HEAD** and
nearly filed it as a flaky-suite defect.

**It is not a suite defect, and this was disproved properly rather than assumed:**
- `deriveScriptureBook` is provably pure — 200,000 calls, 0 nulls, 0 wrong answers.
- Single-file runs (`vitest run src/<one>.test.ts`) are always green.
- A pristine `git archive` snapshot of the same commit ran **15/15 green**.

So the phantom red came from the auditor's own harness poisoning the cache, not from the code.

**How to apply:**
- `rm -rf node_modules/.vite` between mutations, always. Cheap; the alternative is unusable signal.
- Better still for a batch: run mutations against a `git archive` / `git clone` snapshot in a temp
  directory, one fresh checkout per mutation, and delete it after.
- Never batch several mutations into one run and attribute the failures by eye — that is exactly the
  shape that produced the false 29%.
- If you see a failure at what you believe is pristine HEAD: clear the cache and re-run **before**
  reporting a flaky test. Also re-verify with `git status --porcelain` **and**
  `git diff-index --quiet HEAD` — porcelain alone missed nothing here, but the pair is free.
- Any mutation evidence gathered before you knew this needs re-running in a clean snapshot. The
  rows-39–41 auditor re-ran the two polluted experiments (F2b, F3f) and both held up — but it had to
  check.

Related: [[dblib-build-chmod-bin]], [[prisma-migrate-dev-blocked-by-dbos-table]],
[[e2e-test-infra-conventions]] (the separate, genuine `studio-project.e2e.ts` flakiness in nextjs —
do not confuse a real flake with this cache artifact).
