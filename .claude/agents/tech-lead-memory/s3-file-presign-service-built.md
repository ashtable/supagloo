---
name: s3-file-presign-service-built
description: Task 13 (M3, opener) built the S3 presigned-download surface — shared db-lib key-layout helpers, dual-endpoint client factory (sign against public), FilesService with ownership-scoped GET /v1/files/presign-download (404-on-any-denial)
metadata:
  type: convention
---

Built 2026-07-18 (plan task 13) — **opens M3 "Projects + git-ops workflows end to
end" (tasks 13–22)**. TDD plan: `scratch/task-13-s3-file-presign-service.md`.
Depends on [[nodejs-api-bootstrap]] (task 8) + [[auth-and-sessions-built]]
(`requireAuth`, `/v1`, seed) + [[minio-local-s3-parity]] + [[in-flight-dblib-e2e-constraint]]
(e2e in-process). Template: [[openrouter-gloo-connections-built]] (task 12) layering.

**Scope is deliberately ONE route** (design-delta §4/§8):
`GET /v1/files/presign-download?key=` (`preHandler: app.requireAuth`, bearer, NOT
public). presign-upload + `DELETE /v1/files` are DROPPED — uploads are server-side
worker ops, deletes are the cleanup workflow's. Do not build them.

**Key-layout helpers live in db-lib (`src/s3-keys.ts`) — the headline decision
(plan.md risk #3):** `buildAssetKey(projectId, assetId)` → `projects/{p}/assets/{a}`,
`buildRenderOutputKey(id)` → `renders/{id}/output.mp4`, `buildRenderThumbnailKey(id)`
→ `renders/{id}/thumb.jpg`, and `parseS3Key(key)` → tagged union
`{kind:"project-asset",projectId,assetId} | {kind:"render-output"|"render-thumbnail",renderJobId} | null`.
They live in db-lib (re-exported by name from `src/index.ts`, `github.ts` pattern)
so the FUTURE DBOS render workflows (tasks 32/34/36) that WRITE these keys and the
API that PRESIGNS them share ONE format — no writer/reader drift. Canonical shapes
confirmed against db-lib `tests/e2e/schema.e2e.ts` GalleryItem fixtures. No `Asset`
Prisma model — asset ids are just path segments. `parseS3Key` is STRICT: rejects
empty/`.`/`..` segments (traversal), wrong segment count, unknown filenames →
`null`; builders THROW on empty/slash-containing segments (a writer emitting a
corrupt key is a bug, not silent data). Round-trip: `parseS3Key(build…()) ` always
re-derives the ids.

**Dual-endpoint client factory (`src/files/s3-client.ts`), sign against PUBLIC —
the load-bearing rule:** `S3EnvConfig {internalEndpoint, publicEndpoint, region,
bucket, accessKey, secretKey}`, `selectEndpoint(cfg, "presign"|"internal")`,
`makeS3Client(cfg, role="presign")` with `forcePathStyle: true` ALWAYS (MinIO has no
vhost bucket DNS). The API ONLY ever builds the `presign` client → presigned URLs are
signed against `S3_PUBLIC_ENDPOINT` (browser-reachable). A URL signed against the
internal `minio:9000` is unreachable from a browser — that's the whole reason for two
endpoints. The `internal` role exists for future worker ops.

**`FilesService.presignDownload(userId, key)` (`src/files/files-service.ts`):**
parse → ownership → `getSignedUrl(new GetObjectCommand({Bucket,Key}), {expiresIn})`.
Ownership: `project-asset` → `prisma.project.findUnique({where:{id},select:{ownerId}})`
=== userId; `render-*` → `prisma.renderJob.findUnique({where:{id},select:{userId}})`
=== userId (DIRECT field, no join). ANY failure — malformed key, missing row, or
foreign row — throws ONE typed `FileAccessDeniedError` (statusCode **404**,
`src/files/errors.ts`), so 404 vs 403 never distinguishes not-found from forbidden
(no existence leak). Malformed keys are rejected BEFORE any DB call (unit-asserted:
zero prisma lookups). `expiresAt = now + expiresIn` (default 300s), injectable clock.
Project soft-delete (`deletedAt`) is intentionally NOT consulted — ownership only.
**Unit-test insight:** `getSignedUrl` signs LOCALLY (no network), so the service is
fully unit-testable with a REAL `S3Client` (public≠internal endpoints) + a fake
prisma — assert the presigned URL host === public host (the endpoint-selection test).

**Wire DTOs (db-lib `src/schemas.ts`, Files section):**
`FilePresignDownloadQuerySchema {key}`, `FilePresignDownloadResponseSchema
{url, expiresAt}`. NO `File` Prisma model exists → no barrel-collision rule (unlike
the `*ConnectionStatus` suffix rule).

**Env: 6 new S3 vars (`src/config/env.ts`).** `S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`
required http(s); `S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` required min(1);
`S3_REGION` defaults `us-east-1`. Made REQUIRED (fail-fast) because there is no
correct default endpoint/bucket/cred and a wrong one silently signs broken URLs.
`server.ts` is the ONLY `loadEnv` caller and is imported by no test → required vars
only touched `env.test.ts` (`validEnv()` base). Added deps `@aws-sdk/client-s3` +
`@aws-sdk/s3-request-presigner` `^3.717.0` (match root pin). `app.ts` gained
`FilesDeps {service}` + `files?` option registered in the `/v1` block; `server.ts`
builds the presign client + `FilesService`.

**e2e ran IN-PROCESS** (`tests/e2e/files.e2e.ts`, real Postgres + real Compose
MinIO) per [[in-flight-dblib-e2e-constraint]]: PUT fixtures → presign → fetch the
presigned URL FROM THE HOST → round-trip bytes; cross-user → 404; render path;
malformed → 404; no-bearer → 401. `global-setup.ts` extended: `minioReady()` probe
(`GET {S3_PUBLIC_ENDPOINT}/minio/health/live`) added to the reuse gate + `minio`
`minio-init` to the `compose up --build` list + a `waitFor`. The e2e defensively
`CreateBucket` (idempotent) so it never races `minio-init`.

**FOLLOW-UP deferred to the db-lib submodule-bump step (root repo not editable this
task):** add the 6 `S3_*` vars to the `api` service env in root
`docker-compose.yml` + `docker-compose.test.yml` (parallel to task-12's
`SECRETS_ENCRYPTION_KEY` at test.yml:83) — otherwise the containerized API fails env
validation at boot. Containerized/root e2e for this surface stays deferred until then.

**Final green:** db-lib 176 unit (+25) + typecheck 0; API 149 unit (+23) + typecheck
0 + 24 e2e (5 files, +6). Unlike task 12's window, the
`src/dockerfile-database-lib-pin.test.ts` guardrail is GREEN here — the submodule
gitlink and Dockerfile `ARG DATABASE_LIB_REF` are in sync on branch v0.0.15 (a
"bump submodule" commit already landed). Not committed (later workflow step).
