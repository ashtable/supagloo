---
name: in-flight-dblib-e2e-constraint
description: Hard constraint (found task 10) — a consumer repo's Dockerfile/submodule pin lags behind in-flight database-lib changes. CORRECTED 2026-07-21 (task 30): the fix is to release db-lib and bump+fast-forward the pin immediately, never to fake local resolution against unreleased code.
metadata:
  type: constraint
---

**CORRECTION (2026-07-21, task 30) — read this before anything below.** Earlier
guidance in this file (and code from tasks 10/13) treated "make the consumer repo's
tests resolve my uncommitted/unreleased database-lib changes" as an acceptable goal,
achieved via a local `file:`/symlink override pointed at a sibling checkout or an
uncommitted branch. **That premise is wrong.** A consumer repo's tests must only ever
be considered trustworthy when they resolve database-lib through the ACTUAL pinned
submodule commit — the same one recorded in git and the same one a real deploy would
use. Anything else (symlinking `node_modules/@supagloo/database-lib` at an unreleased
sibling checkout, or copying not-yet-committed `dist/` output into the submodule
checkout) lets tests go green against something that isn't actually shippable, and can
silently hide real drift (see the Dockerfile ARG incident below — the shortcut hid a
genuine bug that only surfaced once the fake resolution was removed).

**The correct sequence, every time database-lib changes as part of a task:**
1. Implement + unit-test the database-lib change in isolation, in the standalone
   `~/code/supagloo-database-lib` repo.
2. **Release database-lib immediately** — merge its version branch to `main`, cut the
   next version branch. Do not defer this to an end-of-task "release step"; treat it
   as a normal sub-step of the task itself, as soon as the db-lib change is ready.
3. In the consumer repo (e.g. `supagloo-nodejs-dbos`), fetch and fast-forward the
   nested submodule checkout to db-lib's new `main` commit, then **rebuild the
   submodule's own gitignored `dist/` using its own build script from its own now
   correctly-pinned source** (`cd` into the submodule checkout, `npm run build`) —
   never copy build output in from elsewhere. Commit the submodule bump in the
   consumer repo.
4. **If the consumer repo's Dockerfile clones database-lib at a pinned `ARG` (see
   "the trap" below) — such as `supagloo-nodejs-dbos` and `supagloo-nodejs-api` —
   update that ARG default to the SAME sha in the SAME commit as the submodule bump.**
   A dedicated test (`dockerfile-database-lib-pin.test.ts`, present in both repos)
   enforces this; skipping it leaves `main` in a state where a real Railway build
   would clone a different db-lib commit than the one the submodule pin records.
5. Only now implement/run the consumer repo's tests — they resolve the real,
   pinned, rebuilt dependency, with zero local-only shortcuts.
6. If a later step in the same task needs another database-lib tweak, repeat from
   step 1 — release again, bump+rebuild+sync-ARG again. Do not batch multiple
   in-flight db-lib changes behind one deferred release; each one gets its own
   release-and-bump cycle before its consumer is tested against it.

**A note on the write-into-submodule question**: rebuilding a submodule's OWN
`dist/` from its OWN already-correctly-pinned source, using its own `npm run build`,
is a normal, sanctioned dependency-consumption step — not "editing the submodule."
The auto-mode classifier blocks *any* write action with a cwd inside a submodule
checkout path by default, including running that build script — **but the user has
explicitly granted standing permission for exactly this one exception (2026-07-22):
running `npm install` and/or `npm run build` inside a nested `supagloo-database-lib`
submodule checkout, in any of the three consumer projects that have it
(`supagloo-nodejs-dbos`, `supagloo-nodejs-api`, `supagloo-nextjs` — and their
duplicated copies inside root's own submodule tree).** That's the only sanctioned
write-in-a-submodule action — it must only ever regenerate gitignored build
artifacts (`dist/`, `node_modules`, generated Prisma client) from the submodule's
own already-correctly-pinned source. Never use it to copy files in from elsewhere,
edit tracked source, or run arbitrary other scripts. If the classifier still blocks
it in a given case, stop and ask rather than trying another tool to route around it
— the standing permission is scoped to this specific action, not a general license.

---

Found 2026-07-18 during plan task 10. Direct consequence of
[[nodejs-api-bootstrap]]'s clone-at-build-time Dockerfile.

**The trap:** `supagloo-nodejs-api` (and, per task 30, `supagloo-nodejs-dbos` too)
does NOT copy the local db-lib submodule into its Docker build context — it
**git-clones db-lib from GitHub at a pinned `ARG DATABASE_LIB_REF` SHA**. So a
container build always gets whatever commit that ARG names, regardless of what the
submodule pin (or the local working copy) says. Two consequences:
- If your in-flight code imports a NEW db-lib export before that export exists at
  the pinned ARG commit, the container build clones the OLD db-lib and `npm run
  build` (tsc) fails with exit 2.
- If you bump the submodule pin but forget to bump the ARG default to match, `main`
  ends up internally inconsistent: the submodule pin says one commit, a real
  container build clones a different one. `dockerfile-database-lib-pin.test.ts`
  exists specifically to catch this (see step 4 above) — task 30 tripped it for
  real: the submodule was correctly bumped to `e6e1de4` but the ARG was left at the
  prior `ce2f0d3` until this correction.

**Blast radius while a db-lib release is still pending** — the whole root e2e suite
is blocked in that window. The root harness (`tests/e2e/global-setup.ts`) gates
`infraReady()` on the `api`/`migrate` containers being healthy and, if not, does
`compose up --build INFRA_SERVICES`. While db-lib is mid-release (change made,
release not yet landed), that build can fail, so NO root `tests/e2e/*.e2e.ts` can
run. This is expected and short-lived if you follow the sequence above (release db-lib
right away rather than batching it to the end) — it should never be "worked around"
by pointing anything at unreleased code.

**Exec-bit gotcha (task 13, still applies if you ever do touch a submodule's
`dist/` by hand — which per the correction above should now only ever happen via the
submodule's OWN `npm run build`, never a copy):** `tsc` emits
`dist/check-prisma-version.cli.js` WITHOUT the exec bit; the consumer's
`"postinstall":"check-prisma-version"` (db-lib's bin) needs it +x. The submodule's
own `npm run build` script already does `chmod +x dist/check-prisma-version.cli.js`
as its last step, so running the real build (not a copy) avoids this automatically.

**DBOS-repo specifics (task 30, corrected 2026-07-22):** `supagloo-nodejs-dbos`
consumes db-lib via `node_modules/@supagloo/database-lib`, a `file:./supagloo-database-lib`
dependency resolving to its OWN nested submodule checkout (pinned SHA, gitignored
`dist/`). After following the release sequence above — db-lib released to `e6e1de4`,
the nested submodule fast-forwarded and rebuilt from that pinned source, and the
Dockerfile ARG synced in the same commit as the submodule bump — `npm install` in the
dbos repo correctly resolves the real pinned copy with no override needed. 228 unit +
21 e2e tests passed against this, genuinely, with the classifier-triggering symlink
override fully removed.
