---
name: nodejs-api-bootstrap
description: Task 8 (M2) built the supagloo-nodejs-api Fastify skeleton — CJS + node:22-slim, zod type provider, env loader, /healthz, the db-lib file:-dep/Docker gotchas, migrate service, and the compose-override bridge
metadata:
  type: convention
---

Built 2026-07-18 (plan task 8, top of M2). First real code in
`supagloo-nodejs-api` (was greenfield). Establishes the pattern tasks 9–12
extend; the db-lib-consumption half also applies to task 15 (DBOS bootstrap,
minus the migrate service).

**Module system + runtime:** the API is **CommonJS** (`"type":"commonjs"`, tsc
`module/moduleResolution:node16` → extensionless relative imports, emits
`node dist/server.js`). Chosen over ESM because db-lib + its generated Prisma
client are CJS and the API is their primary consumer — zero interop friction.
Base image is **`node:22-slim` (Debian), NOT alpine** — the API runs Prisma
(`migrate deploy` + building db-lib's client) and Prisma's engines want glibc;
alpine/musl adds openssl friction. (nextjs uses alpine because it runs no Prisma.)

**Stack:** Fastify 5 + `fastify-type-provider-zod@^7` (peer auto-pulls
`@fastify/swagger`; harmless) + `zod@^4.4.3`. `buildApp()` (src/app.ts) sets
`validatorCompiler`+`serializerCompiler` then registers routes — a zod response
schema won't compile without those, so a working `/healthz` proves the provider
is wired. `loadEnv()` (src/config/env.ts) is a zod env loader scoped to
`DATABASE_URL` (required, `postgres(ql)://` refine — not `.url()`) + PORT(4000)/
HOST(0.0.0.0)/NODE_ENV; injectable source for tests. `/healthz` is public,
unversioned (NOT `/v1`), returns `{status:"ok"}` — liveness only, no dep ping.
Tests: unit co-located `src/**/*.test.ts` (vitest.config.ts), non-UI e2e
`tests/e2e/**/*.e2e.ts` (real `listen`+`fetch`, vitest.e2e.config.ts).

**db-lib as `file:./supagloo-database-lib` — the load-bearing gotchas:**
- db-lib's `dist/` is **gitignored** → the submodule MUST be built
  (`npm --prefix supagloo-database-lib ci && … run build`) BEFORE the API's
  `npm install`, or the file: dep packs empty and the `check-prisma-version` bin
  is missing → install fails. Documented in the API README.
- **npm 11 installs a top-level `file:` dep as a SYMLINK**, ignoring
  `install-links` (verified). Fine on host (submodule dir always present). In the
  Dockerfile the built submodule is COPY'd into the builder+runner stages so the
  relative symlink `node_modules/@supagloo/database-lib -> ../../supagloo-database-lib`
  resolves and node_modules stays self-contained across stages.
- On `node:22-slim`, `apt-get install -y openssl` in deps+runner stages, else
  `prisma migrate deploy` warns "failed to detect libssl" and falls back to a
  1.1.x engine.

**Prisma pin wiring (first real consumer of [[prisma-exact-version-pin]]):** API
pins `prisma`+`@prisma/client` to exactly `7.8.0` (db-lib's version), enforced by
`"postinstall":"check-prisma-version"` (db-lib's bin) — a drift/range fails
install. Unit-tested by running db-lib's real `checkPrismaVersion(ownPkg)`.

**`migrate` service (only the API migrates; DBOS never will):** a one-shot
`prisma migrate deploy` using the API's own `prisma.config.ts`, which points
`schema`+`migrations.path` at `node_modules/@supagloo/database-lib/prisma/`
(db-lib ships them via `files:["dist","prisma"]`) and reads `DATABASE_URL` via
`process.loadEnvFile()` (guarded, no dotenv). Applies db-lib's migrations to the
`supagloo` app db.

**Compose (extends [[compose-infra-and-root-test-harness]]):** root
docker-compose.yml gains `migrate` (build `./supagloo-nodejs-api`, depends_on
postgres healthy) + `api` (ports 4000:4000, depends_on migrate
`service_completed_successfully`). Build context is the **submodule** path
(production form, correct after the later submodule bump). A **gitignored
`docker-compose.override.yml`** redirects the context to `../supagloo-nodejs-api`
so `docker compose up --build` exercises in-flight standalone code before the
bump — reusable bridge for every "test uncommitted submodule code" step.
Root e2e harness: `INFRA_SERVICES` now includes `migrate`+`api`; `infraReady()`
also gates on `GET :4000/healthz`; spawn uses `up -d --build`; `API.baseUrl` added
to `tests/support/dev-config.ts`.

**Railway can't build with the submodule — clone db-lib at build time (fix
2026-07-18):** Railway does NOT initialize git submodules and does NOT copy the
outer repo's `.git` into the Dockerfile build context, so the original `COPY
supagloo-database-lib/...` in the deps stage resolved to an EMPTY dir on Railway
and the build failed on the missing `package.json`. Host + Compose builds passed
(submodule populated there), which masked it. This is a hard platform constraint,
not a config toggle. **Fix:** the deps stage installs `git ca-certificates` (same
apt layer as openssl) and **git-clones db-lib from its public GitHub URL** —
`git clone https://github.com/ashtable/supagloo-database-lib.git … && git checkout
"${DATABASE_LIB_REF}" && rm -rf .git` — instead of COPYing it, checked out at an
exact commit via `ARG DATABASE_LIB_REF=<sha>`. Pin a SHA, never a moving branch
(main), so the image stays as reproducible as the submodule pin. Also added
`supagloo-database-lib` to `.dockerignore` so the local checkout can't leak back
into the context and a plain `docker build` reproduces Railway's empty-submodule
condition. Everything downstream (npm ci/build of db-lib, the file: symlink COPY'd
into builder/runner) is unchanged. Proof that matters: build from an *emptied*
submodule dir, not the populated one (the old broken COPY also passes populated).

**ARG↔submodule lockstep + guardrail:** whenever a "Bump supagloo-database-lib
submodule to `<sha>`" commit lands, the Dockerfile's `ARG DATABASE_LIB_REF` default
MUST be updated to that same SHA **in the same commit** — the Dockerfile can't read
the real pin at build time (no `.git` on Railway), so the ARG is the only source of
truth for the image. A co-located guardrail unit test
`src/dockerfile-database-lib-pin.test.ts` fails if the ARG drifts from the recorded
gitlink (read via `git ls-files -s supagloo-database-lib`, chosen over `git
submodule status` because it reads the index gitlink — immune to the submodule's
working-tree checkout, which devs point at in-flight db-lib code before a bump — and
works even when the submodule dir is uninitialized). It needs `.git` present, so it
runs locally/CI, outside the Railway/Docker build boundary. Extends
[[prisma-exact-version-pin]]'s "consumers enforce their own pin" pattern.

**This lands on nextjs + dbos too — copy the pattern, don't reintroduce the COPY:**
`supagloo-nextjs` already carries the `supagloo-database-lib` submodule and will hit
this exact landmine the moment it adds a `file:` db-lib dependency + a `COPY
supagloo-database-lib/...` Dockerfile step (today its Dockerfile never references
db-lib, so it is NOT currently broken). `supagloo-nodejs-dbos` (plan Task 15, not yet
bootstrapped) will need the same clone-at-build-time pattern when it wires up
Prisma/db-lib. Both should adopt the deps-stage form from the start: git-clone at a
pinned `DATABASE_LIB_REF` ARG + `.dockerignore` exclusion + the drift guardrail test
— never the `COPY <submodule-dir>/...` form (it only appears to work locally).
