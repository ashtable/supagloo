---
name: in-flight-dblib-e2e-constraint
description: Hard constraint (found task 10) — the containerized API CANNOT build against uncommitted database-lib changes (its Dockerfile clones db-lib at a pinned SHA), so any task that adds db-lib DTOs must e2e IN-PROCESS until the submodule SHA is bumped
metadata:
  type: constraint
---

Found 2026-07-18 during plan task 10. Applies to EVERY task that adds new
`database-lib` exports (DTOs, helpers) AND wants an e2e before the release/bump
step lands. Direct consequence of [[nodejs-api-bootstrap]]'s clone-at-build-time
Dockerfile.

**The trap:** `supagloo-nodejs-api`'s Dockerfile does NOT copy the local db-lib
submodule — it **git-clones db-lib from GitHub at a pinned `DATABASE_LIB_REF`
SHA**. So when your in-flight API code imports a NEW db-lib export, the container
build clones the OLD db-lib (without it) and `npm run build` (tsc) fails with
exit 2. The API/`migrate` images therefore CANNOT be built from in-flight code
that depends on uncommitted db-lib. Proven: `docker compose ... up --build api`
died on the API's `RUN npm run build` because the cloned db-lib lacked the task-10
`AuthUserSchema` etc.

**Blast radius — the whole root e2e suite is blocked in this window.** The root
harness (`tests/e2e/global-setup.ts`) gates `infraReady()` on the `api` container
being healthy and, if not, does `compose up --build INFRA_SERVICES` (which builds
`api`/`migrate`). While your db-lib change is uncommitted, that build fails, so
NO root `tests/e2e/*.e2e.ts` (yours or pre-existing) can run. This is expected —
the "Bump database-lib submodule to <sha>" + `DATABASE_LIB_REF` update is a
LATER, separate step of the release process.

**The pattern that works NOW (task 10 used it):** e2e IN-PROCESS in the API repo.
- `buildApp({auth})` + real `.listen()` + real `fetch` — the app runs in the
  vitest process, importing db-lib through the local `file:` symlink (not the
  container), so it sees your uncommitted DTOs.
- Real dependencies come from a MINIMAL Compose subset that needs NO API image:
  bring up only `postgres` + the relevant stub(s); apply migrations with the API
  repo's OWN prisma CLI (`npx prisma migrate deploy`, cwd = API repo, its
  `prisma.config.ts` points at `node_modules/@supagloo/database-lib/prisma`) —
  NOT the `migrate` container.
- The API e2e gets its own reuse-or-spawn `globalSetup`
  (`supagloo-nodejs-api/tests/e2e/global-setup.ts`, `SUPAGLOO_ROOT_DIR` env →
  sibling `../supagloo` default) that probes DB + stub (incl. a route-presence
  check so a stale stub image is rebuilt) and `compose up -d --build postgres
  <stub>` only if not already reusable. Deviates from the task-8 "API e2e does no
  docker orchestration" note — auth genuinely needs infra; it's a no-op when a
  stack is already up.

**Getting uncommitted db-lib into the API repo (sanctioned build/link):** edit +
`npm run build` the STANDALONE `~/code/supagloo-database-lib`, then copy its
`dist/` over the API repo's submodule-checkout `dist/`
(`~/code/supagloo-nodejs-api/supagloo-database-lib/dist/`). `dist/` is gitignored
build output, so the submodule's tracked SOURCE stays pristine (never hand-edit
the submodule), and the API's `node_modules/@supagloo/database-lib` symlink
resolves the new exports live — no `npm install`.

**Deferred to post-bump:** the containerized-API full-stack e2e AND the root
`stub-*.e2e.ts` self-tests. Verify the same behaviour meanwhile via the
in-process API e2e (which still hits the REAL containerized stub over HTTP) + the
root IN-PROCESS unit tests (`tests/unit/stub-*.test.ts`). Tasks 11/17+ adding
db-lib DTOs should copy this pattern.
