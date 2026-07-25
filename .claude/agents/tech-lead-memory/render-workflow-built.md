---
name: render-workflow-built
description: Task 36 built renderWorkflow (Remotion bundle+render in a scrubbed-env child, queue `render` 1/worker) — the staticFile/public asset decision, the monotonic-progress + cooperative-cancel mechanics, the 4-level self-healing workspace, and the two DBOS/Remotion gotchas that cost e2e failures
metadata:
  type: context
---

Task 36 (2026-07-24) built `renderWorkflow` in `supagloo-nodejs-dbos`
(`src/workflows/render.ts` + `src/workflows/render/*`), plus `RENDER_WORKFLOW_NAME`
/ `RENDER_QUEUE_NAME` / `RENDER_WORKFLOW_TARGET` / `RenderWorkflowPayloadSchema` in
db-lib. No Prisma change — `RenderJob`, `RenderStatus`, `RenderOutputSpecSchema` and
`buildRender*Key` all pre-existed. API routes are task 37; UI is task 38.

**Step order (pinned by `src/workflows/render.order.test.ts`)**
`markStarted → loadCredentials → mintInstallationToken → cloneAtVersion → readManifest
→ installDependencies → downloadSceneAssets → ensureNarrationAudio → ensureMusicAudio
→ materializeRenderSources → bundleComposition → renderMedia → generateThumbnail →
uploadOutputs → markCompleted`. Runtime status sequence is the design's PROSE order
`queued → synthesizing → bundling → encoding → uploading → …`, **not** the Prisma
enum's declaration order.

## Decisions

- **Assets resolve via `staticFile()`, not a remote URL.** Buckets are private, and
  `@remotion/bundler` 4.0.490 copies `<root>/public` → `<outDir>/public` and serves it
  at `/public` (verified in `bundle.js`). So the OLD template fallback `` `/${assetKey}` ``
  never resolved a bundled public file. `downloadSceneAssets` writes real bytes to
  `<workspace>/repo/public/<assetKey>`; `buildAssetsSource()` now emits
  `staticFile(assetKey)` with `REMOTION_ASSET_BASE_URL` kept as an opt-in remote
  override (the workflow leaves it unset — **no such env var was added**).
- **`materializeRenderSources` regenerates the Remotion sources from the manifest before
  bundling** (`applyManifest` + rewritten `src/lib/assets.ts`). Needed so freshly
  synthesized audio can be REFERENCED without a git commit (which would collide with the
  task-18 per-project 409 git-ops guard), and so repos scaffolded by an older generator
  still render. A no-op for any project whose last commit went through
  `commitVersionWorkflow` (v1: manifest is the sole source of truth).
- **`src/Video.tsx` now emits `<Audio>`** for `narratorVoice.assetKey` / `music.assetKey`.
  Without it "synthesize audio before bundling" is theatre — the file is in the bundle but
  nothing plays it.
- **Audio reuse = direct step helpers, NOT a child workflow.** DBOS supports child
  workflows; `generateAudioWorkflow` is wrong here because it is `AiGeneration`-row-driven
  (workflowID must equal a generation id), delivers to S3 not the workspace, and
  `cancelWorkflow` doesn't cascade to children by default. No `AiGeneration` rows are
  created and nothing is written back to git.
- **Fallback models come from `RENDER_NARRATION_MODEL` / `RENDER_MUSIC_MODEL`** — optional
  with NO default (never hardcode ids, §10.9); unset ⇒ the track is `skipped`, not a
  failed render. Empty string is normalized to undefined (Compose `${VAR:-}`).
- **`renderMedia` is `retriesAllowed: false`** — an hour-long encode that died must not
  silently burn three more hours; DBOS workflow *recovery* is the retry mechanism.
- **Timeouts are child-process kill deadlines** (`RENDER_*_TIMEOUT_SECONDS`), because DBOS
  has no per-step timeout — only workflow-level `timeoutMS`. Tuning is task 45.

See [[render-workflow-gotchas]] for the two bugs the e2e caught, and
[[dbos-render-child-isolation]] for the scrubbed-env child mechanics.
