# Tech Lead — Shared Memory Index (this repo)

This is the shared, cross-session memory for the **tech-lead** (Opus) and
**fabulous-tech-lead** (Fable) persona, **scoped to this repository**. Both
engines read and write here; this memory does not cross into other repos.

Each entry below points to one memory file in this directory. Keep this index to
one line per memory (`- [Title](file.md) — hook`); put the actual content in the
individual files, never here.

## Memories

<!-- Add entries as you learn durable technical facts. Example:
- [Non-UI e2e run via node test runner](non-ui-e2e-runner.md) — how integration tests are invoked
-->

- [Composition source of truth in repo](composition-source-of-truth-in-repo.md) — no Scene/Composition DB tables; supagloo.project.json manifest + S3 media
- [MinIO for local S3 parity](minio-local-s3-parity.md) — compose infra: MinIO dev bucket, dual S3 endpoints, one Postgres with app + DBOS system DBs
- [DBOS static workflows + enqueue pattern](dbos-static-workflows-and-enqueue-pattern.md) — hard constraint: static registration only; API enqueues via DBOSClient, workflowID = record id
- [GitHub App installation tokens](github-app-installation-tokens.md) — store only installationId; mint short-lived tokens on demand, no repo token at rest
- [OpenRouter media + AI SDK split](openrouter-media-and-ai-sdk-split.md) — OpenRouter covers video/TTS/music; generateObject for text, plain fetch for media; never hardcode model ids
- [KJV/BSB generation only](kjv-bsb-generation-only.md) — superseded 2026-07-18: any YouVersion-licensed translation now allowed; KJV/BSB is just the default
- [Prisma exact version pin](prisma-exact-version-pin.md) — consumers must pin database-lib's exact Prisma version, CI-enforced
- [E2E test-infra conventions](e2e-test-infra-conventions.md) — provider stubs + local git server, early /v1/test/seed, Stagehand real-stack mode, DBOS crash/replay tests standard
- [Compose infra + root test harness](compose-infra-and-root-test-harness.md) — task-3 built: postgres/minio/minio-init compose, POSTGRES_DB=postgres gotcha, reuse-or-spawn globalSetup, root Vitest split
- [Node API bootstrap](nodejs-api-bootstrap.md) — task-8 built: Fastify CJS on node:22-slim, zod type provider, zod env loader, /healthz, db-lib file:-dep + Docker symlink + openssl gotchas, migrate service, compose-override bridge; + Railway can't init submodules → Dockerfile git-clones db-lib at a pinned DATABASE_LIB_REF ARG (guardrail test enforces ARG↔submodule lockstep)
- [Provider-stub harness](provider-stub-harness.md) — task-9 built: env-overridable provider base URLs, containerized zero-dep stubs + git smart-HTTP server, docker-compose.test.yml overlay, /__stub introspection, git keep-alive + in-process-deadlock gotchas
- [Auth & sessions built](auth-and-sessions-built.md) — task-10 built: opaque DB-backed sessions, SHA-256 token hash + sliding expiry, bearer plugin, /v1 prefix, invented YouVersion userinfo contract, flag-gated hard-404 seed; wire DTOs in db-lib (AuthUser not User)
- [In-flight db-lib e2e constraint](in-flight-dblib-e2e-constraint.md) — containerized API can't build against uncommitted db-lib (Dockerfile clones a pinned SHA) → e2e in-process (buildApp + postgres/stub subset, local prisma migrate); root/container e2e deferred to submodule bump
- [GitHub App connection built](github-app-connection-built.md) — task-11 built: signAppJwt+mintInstallationToken in db-lib (hand-rolled RS256), install-url/callback/disconnect/repos routes, GithubConnectionStatus (not GithubConnection) wire-name collision rule, required GITHUB_APP_ID/PRIVATE_KEY/SLUG, App-JWT-enforcing stub + /installation/repositories route
- [S3 file presign service built](s3-file-presign-service-built.md) — task-13 built (OPENS M3): shared db-lib key helpers (buildAssetKey/parseS3Key), dual-endpoint client factory (sign against S3_PUBLIC_ENDPOINT, forcePathStyle), FilesService + GET /v1/files/presign-download with 404-on-any-denial ownership scoping; required S3_* env; e2e in-process vs Compose MinIO
- [OpenRouter + Gloo connections built](openrouter-gloo-connections-built.md) — task-12 built (CLOSES M2): POST openrouter (encrypt+keyLast4)/GET credits proxy/PUT gloo verify-then-store/DELETEs/merged GET connections; required SECRETS_ENCRYPTION_KEY (64-hex); gloo-stub `gloo-invalid` verify-failure sentinel; OpenRouterConnectionStatus/GlooConnectionStatus wire-name suffix rule
- [db-lib build must chmod +x bin](dblib-build-chmod-bin.md) — tsc strips exec bit on check-prisma-version.cli.js; rsync-into-consumer local flow then fails postinstall (exit 126); build script chmods it
- [Projects/versions read CRUD built](projects-versions-read-crud-built.md) — task-14 built: GET /v1/projects grid + GET/PATCH/DELETE /:id (rename=name-only, soft-delete=404-on-redelete) + /versions (real-semver desc via shared db-lib semver.ts); ProjectDto/ProjectVersionDto, ProjectNotFoundError 404-scoping; no create endpoint, no migration, no new env
- [Node DBOS bootstrap](nodejs-dbos-bootstrap.md) — task-15 built (OPENS DBOS): worker skeleton mirrors api minus migrate/port; DBOS SDK gotcha (registerWorkflow before launch, registerQueue AFTER); static registry.ts source-of-truth; two-DB env split (app vs supagloo_dbos system); self-managed noop_proof table; in-process DBOSClient idempotency e2e; root dbos compose service + bridge
- [Remotion template generator built](remotion-template-generator-built.md) — task-16 built: pure non-DBOS src/remotion/ generator (manifest→files), AbsoluteFill+named-Sequence composition, getAssetUrl/REMOTION_ASSET_BASE_URL seam, remotion 4.0.490 exact pin, real bundle() e2e via no-globalSetup config; applyManifest full-overwrite (manifest sole source of truth)
