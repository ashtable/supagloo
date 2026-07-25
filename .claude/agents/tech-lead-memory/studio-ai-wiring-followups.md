---
name: studio-ai-wiring-followups
description: Task 57 (nextjs) closed 3 task-35 review gaps — per-scene scripture carry-through through the UI Scene (kills the re-plan reattachment bug), post-commit project.manifest refresh, ai-config override/fallback logging + .env.example docs, and an in-flight preview generating overlay
metadata:
  type: convention
---

Built 2026-07-24 (plan task 57, follow-up to [[studio-ai-wiring-nextjs]] (35)).
**nextjs-only**, no db-lib/API change, no migration, no new required env. TDD plan:
`supagloo/scratch/task-57-studio-ai-wiring-followups.md`. Final: nextjs 422 unit (39
files) + `tsc --noEmit` clean + eslint clean on all touched files (2 pre-existing
errors in untouched files: `provision-effects.test.ts` no-explicit-any + a
set-state-in-effect — NOT introduced by task 57). Not committed (later step).

**Item 1 (the real bug — persisted-data corruption): per-scene scripture carry-through.**
Root cause: the UI `Scene` (`lib/studio/storyboard.ts`) had NO `reference`/`translation`,
so `storyboardFromGenerated` dropped the LLM's authoritative per-scene scripture, and
`serializeManifest` (`lib/studio/manifest-adapter.ts`) rebuilt each scene by
`base.scenes.find(id===)` — and since `storyboardFromGenerated` always assigns `s1…sN`,
a re-plan overlaps base ids by construction, so the OLD id-matched scene's stale
`reference`/`translation` got reattached onto brand-new content and committed. **Fix
(Choice B): `Scene` gained `reference?`/`translation?`; BOTH `hydrateStoryboard` (from
the manifest) AND `storyboardFromGenerated` (from the LLM) populate them; `serializeManifest`
writes the scene's OWN values (`s.reference ?? preserved.reference`, translation cast
`as Translation`), falling back to the id-matched base only when absent** — so the
byte-exact round trip `serialize∘hydrate=id` still holds (a hydrated scene now carries
the manifest's own values). Chose Choice B over "hydrate leaves them undefined" so the
live `Scene` is the single scripture source → enables the inspector test seam below.
NB: nextjs `ManifestScene.translation` is still the KJV/BSB enum (mirror drift from
db-lib's broadened free string, per task 30) — deliberately NOT broadened here (out of
scope, ripples to publish specs); the wire schema/API remains the real validator.

**Item 1 second half: `project` prop is now REFRESHED post-commit.** `rewriteScript`/
`generateStoryboard` read `project.manifest` for scripture, but `project` was a prop
never refreshed → after a re-plan+commit they sent STALE scripture. Fix: `StudioProvider`
moves `project` into `useState` (init from the prop); `commit()` on `job.status==="succeeded"`
does `setProject(p => projectWithManifest(p, committedManifest))` (the `manifest` already
in scope). New pure helpers: `projectWithManifest(project, manifest)` (`lib/studio/project.ts`)
and `sceneScriptureContext(manifest, sceneId)→{reference,translation,language:"eng"}|undefined`
(`lib/studio/manifest-adapter.ts`); `rewriteScript`/`generateStoryboard` now read scripture
via `sceneScriptureContext(project.manifest, …)`. Unit-tested purely (no jsdom — the
component wiring is thin glue proven by e2e). **Test seam:** scene-inspector exposes
`data-scene-reference`/`data-scene-translation` (attribute-only, mirrors task-35's
`data-visual-asset-key`; does NOT touch textContent so the mock exact-copy anchor stays
byte-for-byte).

**Item 2: `resolveGenerationTarget` (`lib/api/ai-config.ts`) now logs override-vs-fallback.**
FIRST `console.*` in the codebase (per prior research) — plain `console.info` with a
greppable prefix `[supagloo:ai-config]`, one line each for provider + model stating
`override` vs `built-in fallback`. Gotcha found in TDD: the fallback hint must NOT
contain the word "override" ("set X to use a different one", not "to override") or the
two paths aren't cleanly distinguishable by a `/override/` vs `/fallback/` assertion.
`.env.example` gained a documented (all-commented, OPTIONAL) block listing every
`SUPAGLOO_AI_MODEL_<KIND>` + `SUPAGLOO_AI_PROVIDER_<KIND>` (6 kinds each). Discovery-
endpoint replacement (task 29 integration) explicitly OUT of scope (future).

**Item 3 (cosmetic): in-flight preview generating overlay.** Pure predicate
`isPreviewGenerating(state)` (`lib/studio/reducer.ts`) = selected scene's image reroll
OR whole-storyboard re-plan running (narration/music = audio-only → no scrim; a
non-selected scene's reroll → no scrim). `player-panel.tsx` renders a
`data-testid="scene-generating"` scrim + spinner (reuses `styles.spin`) inside
`player-frame` when true; clears automatically when the slot settles.

**e2e (both authored, EXECUTION DEFERRED to the release step — same posture as the
task-35 studio e2e; needs `next dev` + built API + ai-generation & commit DBOS workers +
real OpenRouter):** NEW `tests/e2e/studio-replan-scripture.e2e.ts` (E-RS1: generate+commit
plan-1 → re-plan → capture s1's live `data-scene-reference/translation` → commit → reopen
fresh page → persisted s1 scripture EQUALS the captured plan-2 value, content-agnostic so
it holds against a real LLM; selects scenes via `scene-tree-row`+`data-scene-id`). Item 3
folded into existing `studio-ai-generation.e2e.ts` (asserts `scene-generating` appears
after reroll and is gone after the asset lands) rather than a 3rd near-duplicate harness.

**Closes** the task-35 follow-up "thread generated per-scene references through the UI
Scene (a storyboard replan currently preserves base/placeholder references)".
