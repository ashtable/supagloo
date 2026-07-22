---
name: publish-wizard-version-history-wired-nextjs
description: Task 28 (M4) wired the 14a Publish wizard to the real POST /publish + job-stage polling and the 14b version dropdown to GET /versions — the real path is added ALONGSIDE the untouched mock two-step, keyed off project.manifest, with the Model-A ONE-step bump
metadata:
  type: convention
---

Built 2026-07-21 (plan task 28, M4). **nextjs-only** (Task 22 backend —
`POST /v1/projects/:id/publish {message}`, `GET /v1/projects/:id/versions`,
`publishVersionWorkflow` — already merged/released; we consume the contracts). TDD
plan: `scratch/task-28-publish-wizard-version-history.md`. Builds on
[[studio-hydration-commit-wired-nextjs]] (27, the commit real-path template) and
[[publish-version-workflow-built]] (22, the backend + Model A). Realizes
design-delta §5.3 row 7. "⇄ Compare" (14b) + real review-step diff are OUT of scope.

**The mode signal is the SAME as commit: `project.manifest` presence.** MOCK catalog
projects (no manifest) keep the wireframe-literal TWO-step bump untouched (edit v0.0.1
→ tag v0.0.2 → land v0.0.3): `confirmPublish` dispatches the unchanged `PUBLISH_BEGIN`
(seeds the mock `publishLog` LogSequence, ticked by the wizard's own `useEffect`,
`PUBLISH_DONE` does the `publishedVersion`/`postPublishBranch` math), `versionHistory()`
derives the dropdown from two bare strings, `lib/studio/project.ts`'s two-step helpers
are reused. REAL projects run a NEW path added alongside.

**Publish DIVERGES from commit: distinct real reducer actions (commit could share
COMMIT_DONE; publish can't).** The mock `PUBLISH_BEGIN`/`PUBLISH_DONE` bake in the WRONG
two-step math, so real mode needs its own actions: `PUBLISH_REAL_BEGIN` (publishing step
WITHOUT seeding `publishLog` — a null `publishLog` is the mock-ticker's tell AND makes
the wizard ticker a no-op), `PUBLISH_STAGES {rows}` (per-poll, feeds the 7 real stages
via `stagesToLogRows`), `PUBLISH_REAL_DONE {publishedTag, nextBranch}` (authoritative
values ride the PAYLOAD — no client math in the reducer), `PUBLISH_FAILED {error}`
(clears publishing, sets `publishError`, STAYS on the publishing step so the wizard
surfaces the error + a close). New state: `publishStages: LogRow[]|null`, `publishError:
string|null` (both null in mock). Pure `publishOutcome(job, versionBranch)` mirrors
`commitOutcome`: succeeded → `PUBLISH_REAL_DONE {publishedTag: versionBranch, nextBranch:
nextVersion(versionBranch)}`, else → `PUBLISH_FAILED`.

**Model A one-step (client math == server, no re-fetch needed for the card).** At
publish time the working branch is ALWAYS the highest existing semver, so
`nextVersion(versionBranch)` === the server's `nextPatchVersion(highest)`. So the
success card ("v0.0.1 PUBLISHED … editing on v0.0.2") is computed client-side; the
`PublishedStep` was ALREADY mode-correct (reads `lastPublishedVersion` + `versionBranch`,
which the respective DONE actions set) — ZERO component change there. The dropdown
re-reads authoritatively regardless.

**Version dropdown real-mode: fetch-on-open + a pure wire→UI mapper.** `version-menu.tsx`
branches on `project.manifest`: mock → `versionHistory(...)`; real → `fetchVersions(
project.id)` (lazy on-open, the menu only mounts while open; refetch keyed on
`project.id` only) mapped by NEW `versionRowsFromDtos(versions, dirty)` onto the SAME
`VersionRow` shape so the render code is one path. Mapping (API returns DESC by real
semver): wire `working`→UI `working` (showDot=dirty), FIRST wire `published`→UI `live`
(LIVE ON MAIN), later `published`/wire `archived`→UI `archived` (restore visible but
INERT — no restore endpoint exists anywhere), wire `base`→UI `template`. `branch` = the
DTO's `branchName` (verified `v<semver>`: base v0.0.0 / working v0.0.1 / next v0.0.2).

**StudioLog gained a `rows: LogRow[]` prop + a `failed` (red ✕) status** — strictly
additive (the `seq: LogSequence` mock-publish + 14c-render call sites are byte-identical;
`seq` never yields "failed"). The wizard's real step-2 renders the SAME `publishing-log`
container from `publishStages` + a `publish-error`/`publish-error-close` slot on failure
(distinct testids so the mock E-PUB3 "step 2 has no publish-close" stays true — the real
failure close only renders for real projects).

**New surfaces:** BFF `app/api/projects/[id]/publish/route.ts` (POST, thin forwardToApi)
+ `.../versions/route.ts` (GET); contracts.ts += `ProjectVersionState/Dto/ListResponse`
+ `PublishVersion{Request,Response}` (pinned in contracts.test.ts); studio-data.ts +=
`publishVersion(id, message)` + `fetchVersions(id)` (mirror `commitVersion`). Publish
message = `publishReview(project).title` (the reviewed message; no separate input —
one-click like commit's D-2). **Documented cosmetic divergence (out of scope):** in real
mode the ReviewStep still shows the mock diff copy + mock two-step transition
("Publish v0.0.2 ▸") — unasserted; pairs with the deferred review-diff + excluded Compare.

**Final green:** nextjs 354 unit (36 files; +22 new: contracts pins, `versionRowsFromDtos`,
publish/versions effects, reducer real-publish + `publishOutcome`) + `tsc --noEmit` clean
outside the pre-existing pinned db-lib submodule copy + eslint clean on all touched files.
**Mock e2e RAN GREEN** this engagement (Chrome + `next dev`, no API needed): studio-publish
11 + studio/studio-project 20 = 31 green (mock path byte-identical). The REAL-stack spec
`tests/e2e/studio-publish-real.e2e.ts` is written + typechecked; execution DEFERRED to the
release-step harness (needs the API + a running DBOS git-ops PUBLISH worker — `/api/me`
502'd = no API up), same treatment as [[studio-hydration-commit-wired-nextjs]]'s sibling.
Not committed (later workflow step). Stayed on branch v0.0.28.
