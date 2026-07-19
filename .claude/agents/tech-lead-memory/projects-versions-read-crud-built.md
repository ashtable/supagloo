---
name: projects-versions-read-crud-built
description: Task 14 (M3) built the first Project/ProjectVersion read+mutate surface in supagloo-nodejs-api — GET /v1/projects grid, GET/PATCH/DELETE /v1/projects/:id, GET /v1/projects/:id/versions, plus a shared db-lib semver helper
metadata:
  type: convention
---

Built 2026-07-19 (plan task 14) — **2nd task in M3** (after [[s3-file-presign-service-built]]).
TDD plan: `scratch/task-14-projects-versions-read-crud.md`. Depends on task 5
(Project/ProjectVersion Prisma models, already migrated — **NO new migration this
task**) + [[auth-and-sessions-built]] (`requireAuth`, `/v1`, seed). Direct template:
[[s3-file-presign-service-built]] service/route/error/dto/e2e layering +
ownership-scoped-404. e2e IN-PROCESS per [[in-flight-dblib-e2e-constraint]].

**Scope = 5 read/mutate routes ONLY** (design-delta §2.6/§8): `GET /v1/projects`
(grid), `GET/PATCH/DELETE /v1/projects/:id`, `GET /v1/projects/:id/versions`. The
create/import/commit/publish/manifest/jobs endpoints are separate later DBOS-backed
tasks (#18–22) — **there is NO create endpoint in task 14** (so no slug is generated
anywhere here).

**Resolved design gaps (docs were silent — documented in the plan §0):**
- **Slug**: rename touches ONLY `name`; slug is a stable URL identity, never
  regenerated. No slug generator built (its only caller, `POST /v1/projects`, is #18
  — YAGNI). The plan's "slug generation (unique per owner)" bullet is proven as
  *constraint behavior*: e2e asserts two owners CAN share `psalm-121`, one owner
  CANNOT (Prisma `err.code==="P2002"`).
- **PATCH body** = `{ name }` ONLY (min 1; empty/missing → 400). Only field
  design-delta calls editable.
- **Soft-deleted projects 404** on every per-id route (GET/PATCH/DELETE/versions) —
  consistent with the ownership-scoped-404 convention. Missing / foreign-owner /
  soft-deleted are indistinguishable on the wire via ONE typed `ProjectNotFoundError`
  (`statusCode=404`, `src/projects/errors.ts`).
- **DELETE is soft** (`deletedAt = now`, row retained); a **second DELETE 404s** (the
  project is already invisible) — end-state idempotent, not a 2xx re-delete.
- **Version ordering** = REAL semver DESC (`semver` is free-form, non-zero-padded →
  lexical sort is WRONG: `"0.10.0" < "0.2.0"` lexically). Tiebreak = `id` DESC (only
  fires for equal/unparseable semvers; ProjectVersion has no `createdAt`). Sorted
  IN-MEMORY (semver order inexpressible in SQL; few rows/project).
- **One `ProjectDto` for list AND detail** (not summary/detail split); omits `ownerId`
  (caller is owner — connection-DTO precedent) + `deletedAt`. Grid orders by
  `lastOpenedAt` desc.

**semver helper lives in db-lib** (`src/semver.ts`, barrel-exported):
`parseSemver(v) -> {major,minor,patch}|null` (tolerates optional leading `v`; ignores
prerelease/build — v1 only makes `X.Y.Z`), `compareSemver(a,b)` ascending comparator
(unparseable sorts BELOW parseable; two unparseables tie). Placed in db-lib (not the
api) — same shared-domain-helper category as s3-keys/github — because the #22 publish
workflow's next-semver bump will reuse it (one home ⇒ no ordering/bump drift). **No
`semver` npm dep** in either repo (checked) — a 3-int compare doesn't warrant one.

**Wire DTOs (db-lib `src/schemas.ts`, new Projects/Versions banner):** `ProjectDto`,
`ProjectVersionDto` (`*Dto` suffix — bare `Project`/`ProjectVersion` are re-exported
Prisma model types, same barrel-collision rule as `AuthUser`/`*ConnectionStatus`),
`ProjectListResponse`, `ProjectResponse`, `ProjectRenameRequest`,
`ProjectDeleteResponse`, `ProjectVersionListResponse`, `ProjectIdParam`. Reuse the
existing enum mirrors (`RepoVisibilitySchema`/`ProjectCreatedFromSchema`/
`ProjectVersionStateSchema`). `changedFiles` (Prisma `Json`) typed `z.array(z.string())`;
mapper `toProjectVersionDto` passes it through (`row.changedFiles as string[]`).

**api files:** `src/projects/{errors,dto,projects-service}.ts` + `src/routes/projects.ts`;
`ProjectsService {prisma, now?}` — `listProjects/getProject/renameProject/deleteProject/
listVersions`, injectable clock for deterministic `deletedAt`; `getProject` (findFirst,
`where:{id,ownerId,deletedAt:null}`) is the shared 404-scoping gate reused by
rename/delete/listVersions. `app.ts` gained `ProjectsDeps` + `projects?` option in the
`/v1` block; `server.ts` builds `ProjectsService`. **No new env vars, no new npm deps.**

**No root Compose changes needed this task** (no new env), unlike #12/#13 — the only
deferred item is the routine submodule bump + `DATABASE_LIB_REF` update at the release
step so containerized/root e2e can exercise these routes.

**Final green:** db-lib 195 unit (+19) + typecheck 0; api 178 unit (+29) + typecheck 0
+ 30 e2e (6 files, +6, `tests/e2e/projects.e2e.ts`). Guardrail
`src/dockerfile-database-lib-pin.test.ts` GREEN (submodule gitlink ↔ Dockerfile ARG in
sync on v0.0.16; dist synced via rsync into the api submodule checkout + `chmod +x` the
cli bin per [[in-flight-dblib-e2e-constraint]] + [[dblib-build-chmod-bin]]). Not
committed (later workflow step).
