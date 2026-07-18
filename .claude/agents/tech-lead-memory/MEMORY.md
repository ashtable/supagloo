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
- [Node API bootstrap](nodejs-api-bootstrap.md) — task-8 built: Fastify CJS on node:22-slim, zod type provider, zod env loader, /healthz, db-lib file:-dep + Docker symlink + openssl gotchas, migrate service, compose-override bridge
- [Provider-stub harness](provider-stub-harness.md) — task-9 built: env-overridable provider base URLs, containerized zero-dep stubs + git smart-HTTP server, docker-compose.test.yml overlay, /__stub introspection, git keep-alive + in-process-deadlock gotchas
