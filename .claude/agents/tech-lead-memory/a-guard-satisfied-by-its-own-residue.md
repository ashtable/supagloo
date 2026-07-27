---
name: a-guard-satisfied-by-its-own-residue
description: The root dbos-worker guard went green on a dead worker because per-lane schema isolation left 84 matching tables behind — plus the queues-rows predicate that replaced it and the rolled-back-transaction probe that proves discrimination
metadata:
  type: decision
---

Fixed 2026-07-26 (review item W1) in root `tests/e2e/dbos-worker.e2e.ts`.

## What broke

The guard proving the Compose `dbos` worker had launched counted
`information_schema.tables WHERE table_name LIKE 'workflow%' OR table_schema = 'dbos'`
across the whole `supagloo_dbos` database and asserted `> 0`. When
[[dbos-e2e-lane-schema-isolation]] landed, it created **fourteen permanent `dbos_e2e_*`
lane schemas with six `workflow*` relations each**. Measured live: 98 matching tables, 84 of
them residue. **A crash-looping container passes.** A guard whose subject leaves residue
matching its own predicate stops being a guard the moment the residue exists — and the
change that created it was in a different repo.

## The predicate that replaced it

`SELECT name FROM "dbos".queues` — non-empty, and **schema-scoped on purpose** (lane
schemas are other repos' residue and must be excluded deliberately, not by luck). Verified
in `@dbos-inc/dbos-sdk` 4.23.6:

- `sysdb_migrations/internal/migrations.js` creates `<schema>."queues"` **empty** — no seed
  rows;
- rows appear only via `upsertQueue`, whose only caller in this stack is
  `DBOS.registerQueue`, which **opens with `ensureDBOSIsLaunched`**. A row therefore cannot
  exist unless a runtime got past `DBOS.launch()`;
- the api never registers a queue (enqueue-only, `DBOSClient`), so rows in the SHARED schema
  can only be `supagloo-nodejs-dbos/src/dbos/runtime.ts`. Live: `ai-generation, git-ops,
  render`.

Contrast `workflow_queue` (ENQUEUED workflows — legitimately empty right after launch) and
`workflow_status` (created by migration alone). Both prove nothing.

## How to prove a guard discriminates without stopping anything

Build the failure state in a **transaction that is always rolled back**. Postgres DDL is
transactional, so nothing survives even if an assertion throws:

```
BEGIN;
CREATE SCHEMA "dbos_guard_probe";
CREATE TABLE "dbos_guard_probe".queues (LIKE "dbos".queues INCLUDING ALL);
-- assert: new predicate = 0 here, retired predicate still > 0 database-wide
ROLLBACK;
```

`LIKE … INCLUDING ALL` derives the probe from the real migrated table, so it cannot drift
from what the SDK actually creates. The spec now also **counts the residue with `dbos`
excluded** (85 with the probe, 84 without), so the retired predicate's inadequacy is a
recorded number rather than an argument in a comment. No sampling, no timers, the container
untouched — see the standing rule in [[e2e-test-infra-conventions]].

The guard's own red was demonstrated by running its body against that probe schema: it fails
with the diagnostic naming `docker compose logs dbos` and the three env vars.

Related: [[dbos-e2e-lane-schema-isolation]], [[shared-safety-logic-needs-a-marker-fence]].
