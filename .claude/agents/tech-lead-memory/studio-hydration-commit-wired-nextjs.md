---
name: studio-hydration-commit-wired-nextjs
description: Task 27 (M4) wired the studio off the findStudioProject/DEMO_STORYBOARD mock seam — real GET /projects/:id + manifest hydration, a bidirectional manifest⇄storyboard adapter, a real POST /commit + job-poll with a new COMMIT_FAILED state, and the mock/real server-shell branch
metadata:
  type: convention
---

Built 2026-07-21 (plan task 27, M4). **nextjs-only** (all API/DBOS backend already
merged — tasks 20 manifest-read, 21 commit-workflow). TDD plan:
`scratch/task-27-studio-hydration-commit.md`. Builds on
[[bff-foundation-nextjs-built]] (23), [[workspace-project-wizards-wired-nextjs]] (26).
Realizes design-delta §5.3 rows 3 & 6, §2.11 (manifest = sole source of truth).

**Mock/real branching (the key coexistence decision).** The studio route had ZERO
mock/real awareness and every existing studio spec `goto`s a bare catalog id with NO
flag — so I did NOT gate on `?mock=`/session `isMock` (would break them). The SERVER
shell `app/studio/[id]/page.tsx` decides:
1. `NEXT_PUBLIC_SUPAGLOO_DEMO=1` (on in dev/e2e, ABSENT in prod — same prod-safety as
   `parseMockSession`) AND `findStudioProject(id)` hits → render `<StudioApp>` with the
   bundled `DEMO_STORYBOARD` synchronously (zero network, DOM byte-identical → all
   mock studio specs stay green).
2. else, no session cookie (`cookies().get(SESSION_COOKIE_NAME)`) → `notFound()` INSTANT
   (a signed-out visitor owns no real project; keeps E-SP4's unknown-id assertion
   instant instead of racing an async client fetch).
3. else → client `StudioLoader` (`app/studio/_components/studio-loader.tsx`) hydrates
   from the REAL API (client-fetches / BFF-is-the-seam convention, like HomeSwitch).

**The studio's real-vs-mock SIGNAL is `project.manifest` presence, NOT session isMock.**
The resolver injects `manifest` on real StudioProjects; the mock catalog has none. So
`commit()` branches on `project.manifest`: absent → the unchanged mocked
`setTimeout(COMMIT_DONE)`; present → the real serialize+POST+poll. No session state is
threaded into the studio context. `StudioProject` gained optional `slug` (display URL;
`id` is now the cuid in real mode / catalog id in mock) + `manifest` (merge base +
mode signal).

**The bidirectional manifest⇄storyboard adapter (`lib/studio/manifest-adapter.ts`) —
NO prior art, and serialize MUST merge over the source manifest.** The UI
`Storyboard`/`Scene` are MISSING fields the wire `ProjectManifest` requires
(`ManifestScene.reference/.translation/.visualAssetKey`, `composition.width/height/
aspectRatio`, `narratorVoice.label`, `music.assetKey`, `endCard`, `manifestVersion`).
A naive hydrate→edit→serialize DROPS them → invalid manifest (`reference` is required
`min(1)`). So `serializeManifest(sb, base)` writes the editable UI fields (script,
visualPrompt, durationSeconds, name/visualLabel, captions↔onScreenText, musicMood→
music.style) onto the base scene of the SAME id and PRESERVES everything else from
`base` — inverse of `hydrateStoryboard` so `serialize(hydrate(m), m)` deep-equals `m`
(the key round-trip unit test). **The UI aspect toggle is PREVIEW-only and is NEVER
written to `composition`** (design-delta §2 preview/render non-parity). `commitMessage(sb,
base)` is a pure diff → the D-2 default message.

**Commit-message UI decision (D-2): one-click Commit + auto-generated message, NO
modal/input.** The Turn 13b wireframe has a bare one-click "⤓ Commit"; commit is the
lightweight working-branch checkpoint (squash-merged+tagged at publish, so intermediate
messages are low-stakes); publish is the reviewed step (its message rides `publishReview`).
Deferred enhancement: an editable message could ride the same `commit()` entry point.

**Reducer: added the terminal FAILURE state the setTimeout never had.** `StudioState.commitError`
(init null; cleared by COMMIT_BEGIN/COMMIT_DONE). NEW `COMMIT_FAILED {error}` →
`committing:false, commitError set, dirty STAYS true` (retryable — chip stays gold).
Pure `commitOutcome(job: JobLike|null): StudioAction` maps a POLLED terminal commit job
→ succeeded→COMMIT_DONE, else (failed/canceled/null)→COMMIT_FAILED — THIS is the
"dirty/committing transitions against polled job states" that replaces the setTimeout
tests. `JobLike` (job-log.ts) gained an optional `error?`. Context `commit()` reuses
`pollJobUntilTerminal` (task-26 provision-effects — commit jobs are kind-agnostic) +
the `aliveRef` mounted-guard idiom; top-bar shows a `commit-error` slot.

**GOTCHA — a freshly-scaffolded real project has an EMPTY manifest** (`buildBlankManifest()`
= `scenes: []`; scenes arrive via the not-yet-built generation flow). Wiring real
hydration made "Open in studio" reachable for empty-manifest projects, which would
CRASH the scene panels (`initialStudioState`/`SceneInspector` assumed `scenes[0]`). Fix:
`initialStudioState` selectedSceneId is now empty-safe (`?? ""`), and `StudioFrame`
renders a `studio-empty` state (keeps the TopBar) when `scenes.length === 0`. The full
empty editor is OUT OF SCOPE (pairs with the generation UI).

**slug→id resolution:** `GET /api/projects` is the ONLY slug→cuid index (no get-by-slug
route). `loadStudioProject(slug)` = list (slug→id) → `GET /api/projects/:id` (authoritative
dto) → `GET /api/projects/:id/manifest?ref=<currentBranch>` → hydrate. Distinct manifest
error reasons surfaced (404 `manifest_not_found` / 409 `github_not_connected` / 422
`manifest_invalid` → a `studio-load-error` body, vs `studio-not-found`). Effects in
`lib/studio/studio-data.ts` (pure/injectable fetch).

**New BFF routes (thin `forwardToApi`, exact `[jobId]` idiom):** `app/api/projects/[id]/
route.ts` (GET :id), `.../manifest/route.ts` (GET, forwards `?ref=` from
`request.nextUrl.searchParams`), `.../commit/route.ts` (POST `{manifest,message}`).
**contracts.ts** hand-mirrors db-lib: Translation/Composition/Voice/Music/EndCard/
ManifestScene/ProjectManifest + ProjectResponse + ManifestRefQuery/ManifestResponse +
CommitVersion Request/Response (all pinned in contracts.test.ts).

**Real-stack Stagehand spec `tests/e2e/studio-hydration.e2e.ts` WRITTEN, execution
DEFERRED** per [[in-flight-dblib-e2e-constraint]] (needs a locally-built API + a running
DBOS git-ops COMMIT worker + a populated-manifest fixture — a scaffold is empty). Gloo-free
deterministic (testid/evaluate), NOT act/extract/observe (those need the degraded Gloo LLM
client — every prior studio + real spec is deterministic). Behavior proven meanwhile by
unit (adapter round-trip, studio-data effects, reducer commitError/commitOutcome, contract
pins) + the preserved mock studio specs.

**Final green:** nextjs 332 unit (36 files; +new adapter/studio-data/contract/reducer
cases) + `tsc --noEmit` clean in app/lib/tests (the nested `supagloo-database-lib/`
submodule copy has PRE-EXISTING pinned-client tsc errors — out of scope, untouched) +
eslint clean + mock studio e2e 31 green (studio 23 / studio-project 4 / studio-publish...
27 across the two files). Not committed (later workflow step).
