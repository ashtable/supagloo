---
name: manifest-read-built
description: Task 20 (M3) built GET /v1/projects/:id/manifest?ref= — synchronous GitHub Contents-API read + Zod parse + typed error mapping (NOT a DBOS workflow); plus the github-stub's in-memory Contents store
metadata:
  type: convention
---

Built 2026-07-19 (plan task 20). TDD plan: `scratch/task-20-manifest-read.md`.
Depends on task 7 (`ProjectManifestSchema`), 11 ([[github-app-connection-built]]),
14 ([[projects-versions-read-crud-built]] — `ProjectsService.getProject`). e2e
IN-PROCESS per [[in-flight-dblib-e2e-constraint]]. Realizes
[[composition-source-of-truth-in-repo]]'s "manifest reads go through the GitHub
contents API" line.

**Architecture: this endpoint is a SYNCHRONOUS in-process Fastify route, NOT a DBOS
workflow** (design-delta §7 explicitly excludes manifest reads from the workflow
set). Flow: `getProject` (owner-scoped 404) → caller's `GithubConnection` lookup
(caller == owner, so `findUnique({where:{userId}})`) → mint a fresh installation
token → `GET /repos/{owner}/{repo}/contents/supagloo.project.json?ref={ref}` →
base64-decode → JSON-parse → `ProjectManifestSchema.safeParse` → return `{manifest}`.

**Error-status split (design docs silent — decided here):**
- project missing/foreign/deleted → **404** `ProjectNotFoundError` (existing).
- owner has no GitHub connection → **409** `GithubNotConnectedError` (existing;
  matches the `/v1/github/repos` precedent).
- Contents API 404 (repo/branch/file absent) → **404** new `ManifestNotFoundError`
  (`error:"manifest_not_found"`).
- file EXISTS but bad JSON OR fails `ProjectManifestSchema` → **422** new
  `ManifestInvalidError` (`error:"manifest_invalid"`). 422 is the plan's HARD
  requirement for a corrupted manifest; invalid-JSON + schema-mismatch fold together.
- **Why the 404/422 split differs from the DBOS import-verify side** (which
  collapses missing-file + bad-JSON + schema-mismatch into ONE non-retryable
  `ManifestInvalidError`): the DBOS axis is *retryability* (all three are equally
  permanent); the HTTP axis is *client semantics* ("file absent, try another ref"
  vs "file present but garbage"). Both errors carry `statusCode`; the route maps via
  explicit `instanceof` (house style). `ref` defaults to `project.currentBranch`.

**api layering:** `src/manifests/{errors,manifest-service}.ts` +
`src/routes/manifests.ts` (`registerManifestRoutes`, path `/projects/:id/manifest`,
its OWN route module + `manifests?` app dep — like project-jobs, not folded into
`routes/projects.ts`). `ManifestService({getProject, prisma, getFileContents})` —
pure orchestration over 3 injected seams (getProject closure from ProjectsService,
prisma only for the connection lookup, getFileContents = the client method) ⇒ fully
unit-testable with no DB/network. `MANIFEST_FILE = "supagloo.project.json"`.

**Contents-fetch lives on the EXISTING `makeGithubAppClient`** (new
`getRepositoryFileContents({installationId,owner,repo,path,ref})` → `{content,sha,path}
| null`), NOT a new client file — it's a GitHub App op like `listInstallationRepos`,
mints the token internally (fresh-per-call, never stored), 404→null, other non-2xx→
throw. The CLIENT does the base64→utf8 decode (whitespace-stripped — GitHub wraps
base64 with newlines); the SERVICE does JSON.parse + schema validate. Its Zod
response schema pins `type:"file"` + `encoding:"base64"` (manifest is tiny; the
`"none"` >1MB blob-API path never applies).

**db-lib DTOs (`src/schemas.ts`, new Manifest-read section):**
`ManifestRefQuerySchema {ref: string.min(1).optional()}`, `ManifestResponseSchema
{manifest: ProjectManifestSchema}`. No `Manifest` Prisma model ⇒ no barrel-collision
suffix rule. No new env, no migration, no new npm dep.

**E2E stub-fixture improvisation (the one place beyond the design docs — github-stub
got its own in-memory Contents store):** the endpoint hits GitHub's Contents API over
HTTP, not git; the git-server stub (smart-HTTP only, 4805) can't serve a Contents
response and shares no filesystem with github-stub, and shelling `git` in a stub
deadlocks its event loop (per [[provider-stub-harness]]). So
`tests/stubs/src/github-stub.ts` gained: `GET /repos/:owner/:repo/contents/:path`
(requires a `ghs_` installation token → proves the mint; returns the GitHub file
shape `{type:"file",encoding:"base64",content,sha,path,...}` for seeded content, else
404) + `POST /__admin/contents` ({owner,repo,ref,path,content} raw string → base64 +
store, keyed `owner/repo/ref/path`; mirrors git-server's `POST /__admin/repos`
idiom), cleared on `onReset`. In-memory ⇒ no path-traversal surface. The api e2e's
`global-setup.ts` `githubStubReady()` staleness probe now hits the NEW contents route
(unauthed → 401 current / 404 stale) so a reused-but-stale github-stub is rebuilt;
the github-stub build is db-lib-independent so this does NOT trip the in-flight-dblib
API-build block. **`:path` is a single segment** (v1 manifest is always at repo
root; `compilePattern`'s `:param` matches one non-slash segment).

**Deferred (per in-flight-dblib):** root `stub-github.e2e.ts` self-test (root e2e
harness builds the `api` container → blocked until the submodule bump) — covered
meanwhile by the root IN-PROCESS unit test (`tests/unit/stub-github.test.ts`, +3) and
the api in-process e2e (which hits the REAL containerized contents route over HTTP).
No root docker-compose change (no new env; stub already a service).

**Final green:** db-lib 234 unit (+3) + typecheck 0; api 222 unit (+10) + typecheck 0
+ 41 e2e (8 files; +7 `tests/e2e/manifest.e2e.ts`); root 72 unit (+3) + stubs tsc 0.
Not committed (later workflow step). Local db-lib linkage via the sanctioned rsync
dist→api-submodule + `chmod +x` the cli bin ([[dblib-build-chmod-bin]]).
