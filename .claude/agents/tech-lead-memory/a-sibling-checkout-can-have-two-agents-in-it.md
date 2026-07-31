---
name: a-sibling-checkout-can-have-two-agents-in-it
description: Two agents can be editing the SAME sibling checkout at once, so `git add -A` commits the other one's work under your message — measured 2026-07-31 when an E-C4 flake fix swallowed a whole YouVersion cache-variant workaround; stage by path, and read `git log` before you believe your own commit
metadata:
  type: constraint
---

Measured 2026-07-31 in `supagloo-nextjs`. Two agents were working the same post-release
sweep, in the **same working directory** — not worktrees, not branches. Timeline:

| time | who | what |
|---|---|---|
| ~04:15–04:31 | agent A (this one) | edits `lib/youversion/client.ts`, `client.test.ts`, `tests/e2e/bible-youversion-live.e2e.ts` |
| **04:22:20** | agent B | `git add -A && git commit` for an unrelated E-C4 flake fix — sweeps **all three** of A's in-progress files into `1d7c62f fix(e2e): E-C4 must wait for the credits read to settle` |
| 04:31:52 | agent A | `git add -A && git commit` — its message describes the workaround, but its diff is only the **two leftover files** |

Nothing was lost and the branch tip is correct. What was destroyed is **attribution**: the
release reads commit subjects, and on that branch a cache-variant workaround now ships
under a subject about a credits assertion, while the commit that *describes* the workaround
does not contain it. That is precisely the shape
[[subagents-can-fabricate-a-user-request]] says to audit for — and here it happened with
nobody lying.

## What to do instead

- **Stage by path.** `git add <the files you touched>`, never `git add -A`, in any repo you
  do not exclusively own for the duration.
- **Verify the commit you just made**: `git show --stat HEAD`. If the file list is not the
  list you expected, something else is in the tree with you. Do not trust the fact that
  `git commit` printed your subject.
- **Check `git log --format="%h %ci %s"` before committing.** A commit dated inside your own
  editing window, that you did not make, is the tell.
- **Do NOT try to repair it by rewriting history.** Another agent — and possibly a running
  e2e lane — shares that checkout and that branch. Report the tangle to the user instead;
  a messy history they know about beats a rebase that detaches somebody's HEAD mid-run.

Concurrency shows up in the harness too: both agents' `vitest` lanes want port 3000, the
same Docker Compose stack and the same GitHub installation. Check `pgrep -fl "[v]itest"`
before starting a lane — the bracket matters ([[pgrep-waiter-matches-itself]]).

Related: [[e2e-review-passes-multiply-fixture-repos]],
[[nextjs-real-lane-builds-api-from-the-submodule-pointer]].
