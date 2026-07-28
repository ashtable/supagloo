---
name: genesis1-studio-share-bugs-built
description: The 7 genesis-1 studio/share fixes (2026-07-27) — scripture picker, bounded add/delete scene, the SHARE popover prune, a header Render button, and the Publish gate — plus the seams each one added and the two traps that cost the most time
metadata:
  type: context
---

Seven user-reported studio bugs, all landed in `supagloo-nextjs` except the RTL half, which
also touched `supagloo-nodejs-dbos`'s render generator. **db-lib and the api were not
touched at all** — no release chain.

| # | What shipped | Where |
|---|---|---|
| 1 | language → translation → book → chapter → verse picker in the Inspector, over six new BFF routes | `lib/youversion/**`, `app/api/bible/**`, `app/studio/_components/scripture-picker.tsx` — see [[youversion-bible-read-surface-lives-in-nextjs]] |
| 2/D3 | real `ADD_SCENE`/`DELETE_SCENE`, bounded **5..10 in the model** | `lib/studio/storyboard.ts` (`addSceneAfter`, `deleteScene`, `MIN_SCENES`/`MAX_SCENES`) |
| 3 | `Render & Share ▸` → **`Share ▸`**; `SHIP IT` → a Semi-Cond `SHARE` eyebrow; the 3 platform chips disabled with tooltips | `top-bar.tsx`, `ship-menu.tsx` |
| 4 | the "daily recurring post" block deleted **and its whole backing model** — `PostingKey`, `StudioState.posting`, `TOGGLE_POSTING` | `reducer.ts` |
| 5 | `Share to the gallery`, **disabled + UNCHECKED** (D2), not wired to the gallery endpoint | `ship-menu.tsx` |
| 6 | `render-button` (`Render ▸`) right of Commit, calling the existing `startRender()` | `top-bar.tsx` |
| 7 | Publish disabled when nothing is ahead of main | `lib/studio/top-bar-gates.ts` — see [[head-commit-sha-ahead-of-main-is-not-an-invariant]] |

## Seams a later spec can use

`render-button` · `share-tiktok` / `share-yt-shorts` / `share-add-platform` (all
`disabled`) · `share-gallery` (`data-checked="false"`, `disabled`) · `scene-tree-add` (now a
`<button>`) · `delete-scene` · `scripture-picker` + `picker-language` / `picker-translation`
/ `picker-book` / `picker-chapter` / `picker-verse` / `picker-error`.
`render-share` and `ship-menu` KEPT their testids — `studio-publish.e2e.ts` E-RND1 pins that
`render-share` opens `ship-menu` and stays distinct from the render overlay.

## Two design rules that made the rest cheap

- **The caption IS the script** (`visibleCaption(scene) === scene.script`). So item 1's
  "the caption updates too" and item 2's "edits reflected in captions" needed **zero**
  extra plumbing — only a way to create scenes.
- **The picker/AI controls are gated on `project.manifest`**, the studio's existing
  real-vs-mock signal. That keeps the 13b mock inspector byte-for-byte AND guarantees the
  mock e2e lane still makes zero network egress.

## Two traps that cost real time

1. **A new scene may not have an empty script.** `scriptText: z.string().min(1)` in BOTH
   manifest mirrors (db-lib `schemas.ts:198`, nextjs `contracts.ts:432`), so a blank scene
   makes the manifest invalid and `POST /commit` answers 422 `manifest_invalid` — "add a
   scene" would leave the project unsaveable. A new scene COPIES the source line (which is
   also the honest start of a split: duplicate, then trim). Caught by a
   `ProjectManifestSchema.safeParse` in `manifest-adapter.test.ts`, not by a shape check.
2. **`lib/config/env.ts` is the ONLY file allowed to read `YV_APP_KEY`** —
   `tests/unit/boot-hardening.test.ts` D43.2 walks the source tree for
   `process.env.YV_APP_KEY`. Go through `loadNextjsServerEnv()`.

Also: React's `react-hooks/set-state-in-effect` is an **error** (not a warning) in this
repo's eslint config, so a cascading dropdown cannot clear its dependent lists with
`setState(null)` in an effect body — key each list by the selection that produced it and
read it back only on a key match.

Related: [[rtl-via-dir-auto-not-a-manifest-field]],
[[scaffold-merge-sha-fix-made-a-fresh-publish-impossible]],
[[nextjs-unit-lane-component-rendering]], [[nextjs-dev-work-goes-in-sibling-checkout]].
