---
name: compose-infra-and-root-test-harness
description: Root-repo Compose infra (postgres/minio/minio-init) + the greenfield root Vitest harness built in task 3 — file layout, the POSTGRES_DB gotcha, and conventions later root tasks reuse
metadata:
  type: convention
---

Built 2026-07-17 (plan task 3, M1). The root `supagloo` repo now has real Node
tooling and a bootable infra slice. Implements [[minio-local-s3-parity]].

**Compose (`docker-compose.yml`)** — services: `postgres` (postgres:17-alpine,
healthcheck `pg_isready -U supagloo`, `pgdata` volume, 5432), `minio`
(9000 API / 9001 console, `minio-data` volume), one-shot `minio-init`
(`minio/mc`, `depends_on: [minio]`, `entrypoint: ["/bin/sh","-c"]` + an
`until mc alias set …; sleep 1; done` retry loop then `mc mb --ignore-existing
local/supagloo-dev`), plus the untouched `nextjs`. `migrate`/`api`/`dbos` are
deliberately NOT here yet (tasks 8/15).

**THE gotcha — `POSTGRES_DB: postgres` is mandatory.** The postgres image, when
`POSTGRES_DB` is unset, defaults it to `POSTGRES_USER` (`supagloo`) and
auto-creates that db before running `/docker-entrypoint-initdb.d/*` (which run
under `psql -v ON_ERROR_STOP=1`). So an unconditional `CREATE DATABASE supagloo;`
would hit "already exists" and abort container init. Pinning `POSTGRES_DB:
postgres` makes the image create neither app db, so the init script
`infra/pg-init/01-create-databases.sql` is the single source of truth and both
`CREATE DATABASE supagloo;` / `CREATE DATABASE supagloo_dbos;` are unconditional.
(Relevant to task 46 Railway parity — same two-db split there.)

**Root Vitest harness** (mirrors `supagloo-nextjs`): `vitest.config.ts` (unit,
`tests/unit/**/*.test.ts`, no infra) vs `vitest.e2e.config.ts` (e2e,
`tests/e2e/**/*.e2e.ts`, `fileParallelism:false`, long `hookTimeout`,
`globalSetup`). Scripts: `test`/`test:unit`=`vitest run`,
`test:e2e`=`vitest run --config vitest.e2e.config.ts`. All deps are
devDependencies (root ships nothing at runtime): vitest, typescript, pg, @types/pg,
@aws-sdk/client-s3, @aws-sdk/s3-request-presigner, yaml.

**Reuse-or-spawn globalSetup** (`tests/e2e/global-setup.ts`): `infraReady()` =
pg-connect to BOTH `supagloo` and `supagloo_dbos` AND `HeadBucket(supagloo-dev)`
(the dbos-db connection proves the init script ran; HeadBucket proves minio-init
ran). If ready → reuse, no teardown; else `docker compose up -d postgres minio
minio-init`, poll ready, return a teardown that runs `docker compose down`.
Reuse this pattern for future root e2e (tasks 9/45/47).

**Canonical dev connection config** lives in `tests/support/dev-config.ts`
(`PG`, `S3`, `makeS3Client`) — env-var-with-Compose-default so tests run
out-of-the-box. Dual S3 endpoints documented in root `.env.example`
(`S3_ENDPOINT`=`http://minio:9000` internal, `S3_PUBLIC_ENDPOINT`=
`http://localhost:9000` for signing host-reachable presigned URLs). Presigned
URLs are the S3 access mechanism (bucket stays private — an unsigned GET 403s),
and MinIO requires `forcePathStyle: true`.
