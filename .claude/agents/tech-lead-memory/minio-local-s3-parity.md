---
name: minio-local-s3-parity
description: Local dev replicates S3 with MinIO in docker-compose (separate dev bucket, dual endpoint env vars); Postgres 17 container hosts both app and DBOS system databases
metadata:
  type: decision
---

Decided 2026-07-17 in `docs/design-delta.md` (§4): local dev S3 = **MinIO**
container in the root `supagloo` docker-compose (bucket `supagloo-dev`,
created by a one-shot `minio/mc` init service). Prod keeps the existing
Railway bucket. Dev and prod buckets are always separate; parity is achieved
purely via env config (`S3_ENDPOINT`, `S3_BUCKET`, keys, `forcePathStyle`)
with the same AWS SDK v3 code path.

Gotcha baked into the design: presigned URLs must be signed against a
browser-reachable endpoint, so the API takes `S3_ENDPOINT` (internal,
`minio:9000`) AND `S3_PUBLIC_ENDPOINT` (`localhost:9000` locally).

Postgres: one `postgres:17` container, init script creates two databases —
`supagloo` (Prisma app schema) and `supagloo_dbos` (DBOS system DB). Same
split intended on Railway prod (open question Q7: confirm CREATE DATABASE is
possible there).

**Why MinIO over LocalStack:** we need exactly one AWS service; MinIO is a
real S3-compatible object store in one small container with first-class
presigned-URL support; LocalStack is heavier and its S3 is an emulation.

**Rejected:** cloud dev bucket (breaks `docker compose up` self-sufficiency
and offline dev).
