---
name: dbos-e2e-lane-schema-isolation
description: How the "keep the Compose dbos container idle" e2e precondition was killed — per-lane DBOS system SCHEMA via systemDatabaseSchemaName, plus the ordering rule that makes its guard diagnostic
metadata:
  type: decision
---

Landed 2026-07-26. Every DBOS-touching e2e spec in **api** (4) and **dbos** (10) now runs on its
own Postgres SCHEMA inside the existing `supagloo_dbos` database, via the SDK's
`systemDatabaseSchemaName`. They pass with `supagloo-dbos-1` **running** — verified with a 5-second
container-state sampler across the whole sweep. The old header notes demanding an idle container
are gone; a grep for them across all six repos returns zero.

**Why a schema, not a third database or `appVersion`.**
- A third `supagloo_dbos_*_e2e` database contradicts three design documents that state the topology
  as exactly **two** logical databases. A schema keeps that sentence true, and design-delta §4 /
  §9-Q7 already designs schema-level isolation as the single-database deployment fallback — so
  `DBOS_SYSTEM_DATABASE_SCHEMA` is a production key implementing a designed shape, not a test hook.
  Nothing switches on "am I in a test"; specs pass the value **explicitly at the call site** and
  never read the env var.
- `appVersion` pinning closes only ONE direction. The SDK's dequeue predicate is
  `(application_version IS NULL OR application_version = $3)`, so a version-pinned stand-in would
  still steal NULL-versioned REAL enqueues — worse than the bug. **Schemas close both directions.**

**Trade-offs:** a new optional key in two production env loaders, and a new footgun — a schema set
on `api` but not `dbos` leaves the api enqueueing where nothing polls, with jobs sitting queued
forever and no error anywhere. Fenced by root `tests/unit/compose-config.test.ts` "PART V invariant
6" (per-file pairing + merged-stack equality + unset-everywhere) and by
`compose-test-overlay.test.ts` (the overlay may never set it). Both proven by mutation, not by
having been red.

## The two rules that make the guard worth having

1. **BOTH halves, or it is decoration.** Runtime (`DBOS.setConfig` / `launchDbos`'s env) AND
   client (`makeDbosEnqueuer` / `DBOSClient.create`). `assertLaneRuntimeIsolated` covers the first,
   `assertWorkflowIsolated` the second. Dropping either one is a real, reachable failure.
2. **`assertWorkflowIsolated` must come BEFORE the spec's first wait on that workflow.** This was
   wrong in the first cut and measured: with the assertion sequenced after a `waitFor`, dropping
   the enqueuer's schema failed as a bare `waitFor timed out` after 10 s naming neither cause nor
   remedy. Moved ahead of the wait, the same mutation fails in milliseconds with the remedy. Every
   `POST` that enqueues awaits the enqueue before answering 201, so no polling is needed.

**Nine of the ten dbos specs originally had only the runtime half** — and that gap is a *green lie*
generator, not a cosmetic one: with the client half dropped the container executes the very
workflow the spec enqueued, drives the SAME app-DB rows and MinIO objects, and every assertion
still passes. The spec goes green having proven the CONTAINER works. For the cancel and
crash/replay specs it is worse — they would be measuring an executor they do not control. Folded
into each spec's existing first enqueue; never a synthetic one.

## Gotchas paid for

- **`queues`, not `workflow_queue`.** `workflow_queue` holds ENQUEUED workflows and is legitimately
  empty right after launch, so it proves nothing. `queues` is the registered-queue table.
- **`resetLaneSchema` before `DBOS.launch()`,** or a crashed previous run's PENDING row is adopted
  by the recovery sweep (same `executor_id = "local"`, same auto-computed app version).
- **The name grammar is the safety property.** `dbos_e2e_<lowercase>` + a 63-byte cap is the ONLY
  thing keeping the interpolated `DROP SCHEMA … CASCADE` away from production `dbos` — Postgres
  truncates over-long identifiers *silently*, which would re-share a schema between two lanes.
- **`src/testing/**` is excluded from `tsconfig.build.json` in both repos** but NOT from
  `tsconfig.json`, so the helper is typechecked and never shipped. The **e2e specs are not
  typechecked at all** (`include: ["src/**/*.ts"]`) — a spec edit must be RUN, never trusted to
  `tsc`.
- **The helper is deliberately duplicated** in api and dbos. Routing it through the root checkout
  would make specs that need no root checkout depend on one, and the two repos must never share a
  lane schema name anyway.

## Blast radius observed live

Running one mutated spec (enqueuer half removed) put 11 real `scaffoldProject` rows into the shared
`dbos` schema; the containerised worker dequeued and ERRORed every one against fixtures that only
existed in the test's imagination. Separately, `supagloo-dbos-1` **exited 0 on its own** mid-session
shortly after those mutation runs, cause not recoverable from its logs. Treat "the container is up"
as something to *sample*, not assume — see [[e2e-test-infra-conventions]].

Supersedes the "stop the container" advice in [[e2e-test-infra-conventions]] and
[[api-job-creation-polling-built]].
