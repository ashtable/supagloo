---
name: nodejs-dbos-bootstrap
description: Task 15 built the supagloo-nodejs-dbos worker skeleton — static registry, DBOS SDK queue-timing gotcha, self-managed noop_proof app-DB table, two-DB env split, in-process e2e
metadata:
  type: context
---

Task #15 (M3) bootstrapped `supagloo-nodejs-dbos` (the DBOS worker). Structurally
mirrors `supagloo-nodejs-api` (see [[nodejs-api-bootstrap]]) — CJS + node:22-slim,
node16 tsconfig, `file:` db-lib dep + git-submodule, `postinstall: check-prisma-version`,
two-tier Vitest (`vitest.config.ts` unit / `vitest.e2e.config.ts` e2e with
`fileParallelism:false` + reuse-or-spawn `global-setup.ts`), 3-stage Dockerfile that
git-clones db-lib at `ARG DATABASE_LIB_REF` (guardrail test enforces ARG↔submodule
lockstep). **Differences from api:** NO `migrate` service / NO `prisma.config.ts`
(only the API runs `prisma migrate deploy`); NO exposed port (no public HTTP surface);
uses the functional DBOS API (no class decorators, so no `experimentalDecorators`).

**DBOS SDK queue-timing gotcha (verified `@dbos-inc/dbos-sdk@4.23.6`, load-bearing):**
- Workflows: `DBOS.registerWorkflow(fn, { name })` — synchronous, at **module load,
  BEFORE `DBOS.launch()`**. This is the call the "zero dynamic registration" constraint
  ([[dbos-static-workflows-and-enqueue-pattern]]) governs. Importing the workflow module
  is what registers it; `runtime.ts` imports `../workflows/*` before launch.
- Queues: `DBOS.registerQueue(name, { workerConcurrency })` is **async and must run
  AFTER `DBOS.launch()`** (persists a row to the system DB so an external `DBOSClient`
  sees it). The module-load `new WorkflowQueue(name)` form is **deprecated/in-process-
  only** — do NOT use it. Resolution: the queue SET + concurrency is a frozen constant
  table (`src/dbos/registry.ts` `QUEUE_CONFIG`); `runtime.ts` iterates it post-launch.
  Still fully static — the constraint is about workflow shapes, not the registerQueue
  call site.

**Registry is the single source of truth** (`src/dbos/registry.ts`, pure data, no DBOS
import): `QUEUE_CONFIG` (`git-ops`:4, `ai-generation`:8, `render`:1), `WORKFLOW_NAMES`
(`noopProof`), `WORKFLOW_QUEUE` (`noopProof→git-ops`). The unit test pins the exact set
WITHOUT launching DBOS. The API's static kind→workflow enqueue table (task 18) imports
these same constants — pin them, never rename queue names.

**Two databases, two env vars** (`src/config/env.ts`, minimal — scope grows per task):
`DATABASE_URL`→app db `supagloo` (workflow domain writes via db-lib Prisma client);
`DBOS_DATABASE_URL`→system db `supagloo_dbos` (`DBOS.setConfig({ systemDatabaseUrl })`).
`DBOS.launch()` auto-creates its own `dbos` schema (~14 tables) in the system DB — no
Prisma migration touches it. Provider-URL/secret/S3 vars are deferred to the later dbos
tasks that use them (adopt api's identical names then).

**noop proof workflow** (`src/workflows/noop-proof.ts`): one `DBOS.runStep` INSERT into a
**self-managed `noop_proof` table** in the app DB, created idempotently at boot via raw
SQL (`ensureNoopProofTable`, `CREATE TABLE IF NOT EXISTS`). It is NOT in db-lib's Prisma
schema (can't edit db-lib; dbos has no migrate). Plain INSERT keyed by `DBOS.workflowID`
so the e2e's "exactly one row per workflowID" is a real exactly-once proof.

**e2e is in-process** (`tests/e2e/noop-workflow.e2e.ts`, matches [[in-flight-dblib-e2e-constraint]]
precedent): `launchDbos(env)` in `beforeAll`, enqueue via a real `DBOSClient.enqueue({
workflowName, queueName, workflowID }, payload)`, `handle.getResult()`, assert 1 app-DB
row; re-enqueue SAME workflowID → still 1 row + original result returned (DBOS attaches to
the completed workflow, does not re-run). global-setup reuse-or-spawns ONLY root-Compose
`postgres` (both DBs via pg-init; no migrate/stubs/minio — noop makes no provider calls).
Containerized-worker run deferred to the deploy task (46).

Root Compose: added a `dbos` service (build `./supagloo-nodejs-dbos`, `depends_on:
migrate: service_completed_successfully`, both DB URLs in env, no `ports:`) + the
`docker-compose.override.yml` bridge to `../supagloo-nodejs-dbos`; root
`tests/unit/dbos-compose.test.ts` mirrors `api-compose.test.ts`.
