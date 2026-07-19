---
name: remotion-template-generator-built
description: Task 16 built the pure Remotion project template + manifest→code generator in supagloo-nodejs-dbos (src/remotion/)
metadata:
  type: context
---

Task #16 built the Remotion project **template file set + `manifest → generated files`
generator** in `supagloo-nodejs-dbos` under `src/remotion/`. Pure, non-DBOS module (adds
NO workflow, NO `registry.ts` entry) — the future scaffold (Task 17) and commit (Task 21)
DBOS steps will wrap its fs functions in `DBOS.runStep`.

**Module shape (two layers):** pure content generators + thin fs wrappers.
- `generate.ts` — `generateProjectFiles(manifest)` (FULL scaffold) = `generateStaticFiles()` ∪
  `generateManifestFiles(manifest)` (DERIVED subset). ONE derived code path → scaffold + regen
  can't drift. `GeneratedFile { path; contents }`.
- `scaffold.ts` — `writeRemotionScaffold(manifest, dir)` (full write, always mkdirs
  `src/scenes` even for 0 scenes) and `applyManifest(manifest, dir)` (regeneration: FULL
  deterministic overwrite of `src/scenes/` — deletes stale scene `.tsx`, leaves static files
  untouched; byte-idempotent). **v1: manifest is SOLE source of truth, hand-edits NOT
  preserved** (design-delta §2).
- `naming.ts`, `manifest-json.ts` (canonical `supagloo.project.json`), `templates.ts`
  (all file-body builders), `versions.ts`, `index.ts`.

**Generated project layout:** `remotion.config.ts` (root = "is-this-a-Supagloo-project"
marker, verifySupaglooProject), `package.json`/`tsconfig.json`/`.gitignore`, `supagloo.project.json`
(DERIVED, canonical), `src/index.ts` (`registerRoot(RemotionRoot)`), `src/Root.tsx` (one
`<Composition id="Main">`), `src/Video.tsx`, `src/lib/assets.ts` (`getAssetUrl`), `src/scenes/<Component>.tsx`.

**Key decisions (see full plan `~/code/supagloo/scratch/task-16-remotion-template-generator.md`):**
- **Composition uses `<AbsoluteFill>` + named `<Sequence from=… durationInFrames=…>`** (NOT
  `<Series>`) — per `remotion-best-practices` skill. Scenes animate via inline
  `interpolate(useCurrentFrame(),…)`, no CSS transitions, `<Img>` + remote URL for the visual.
- **Asset seam:** `getAssetUrl(key)` builds a remote URL from `REMOTION_ASSET_BASE_URL`
  (Remotion-injected env). Assets in S3, never `public/`/`staticFile`. Invented here; render
  task finalizes.
- **Scene naming:** `scene.name` → PascalCase (`Scene`/`Scene<n>` fallbacks), case-insensitive
  `+N` dedup; component id == filename base.
- **Deferred to future tasks (in manifest, NOT rendered in v1):** audio (narration has no
  per-scene asset key in schema; music alone lopsided) and `endCard` (would break "duration =
  Σ scene frames"). Template is visual-only.
- **Versions (exact pins, no `^`):** `remotion` + `@remotion/bundler` = **4.0.490** (npm latest
  was 4.0.492; pinned 4.0.490 to match the sibling supagloo-nextjs `<Player>` anchor —
  cross-repo bundle/Player compatibility). `react` + `react-dom` = **18.3.1**. All four in dbos
  `dependencies` (worker calls `bundle()` at render time). Guardrail test cross-checks these
  vs. `REMOTION_VERSION`/`REACT_VERSION` constants stamped into generated package.json.

**Tests:** golden-file unit tests (`__golden__/shelter/…`, byte-exact), naming/idempotency/
round-trip, fs scaffold behaviors. **E2E = real `@remotion/bundler` `bundle()`** of shelter +
empty fixtures (NO render, NO browser — that's `@remotion/renderer`/Chromium, out of scope) via
a dedicated **no-globalSetup `vitest.e2e.bundle.config.ts`** (`test:e2e:bundle`) so the fs+webpack
test never spins Postgres. Existing DB e2e config got one additive `exclude` for `*.bundle.e2e.ts`.
`bundle()` never reads `remotion.config.ts` (that's the CLI), so `@remotion/cli` is only in the
GENERATED project's package.json, not installed in dbos.

**Post-review fix (2026-07-19):** `applyManifest`'s stale-scene cleanup does
`rm(join(scenesAbs, name), { force: true, recursive: true })` — `recursive: true` is REQUIRED.
The generator only writes flat `.tsx` into `src/scenes/`, but the cleanup `readdir`s whatever is
actually on disk, and `fs.rm` with `{ force: true }` alone throws `ERR_FS_EISDIR` on a directory.
Once repo-import (Task 19) lands, an imported repo's `src/scenes/` shape is NOT validated by
`verifySupaglooProject`/`parseManifest`, so a stray subdirectory there would crash cleanup without
`recursive`. Guarded by a red/green unit test in `scaffold.test.ts` ("cleans up a stray
subdirectory under src/scenes without crashing").
