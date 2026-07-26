---
name: nextjs-eslint-ignores-vendored-checkouts
description: supagloo-nextjs' `npm run lint` was red at HEAD because eslint was linting the db-lib submodule and supagloo-prompts; globalIgnores now excludes them, matching tsconfig
metadata:
  type: convention
---

`npm run lint` in `supagloo-nextjs` was exiting 1 long before row 41 — 229 errors, ~225
of them inside `supagloo-database-lib/`, a git SUBMODULE with its own lint config, its own
committed `dist/` (CommonJS `require()`), and a standing rule that it is never edited from
a consumer repo. Every one of those failures was unfixable from where it was reported.

`eslint.config.mjs` now lists `supagloo-database-lib/**` and `supagloo-prompts/**` in
`globalIgnores`, which is exactly what `tsconfig.json`'s `exclude` already did — the two
tools now share one definition of "what is ours".

That left two REAL, pre-existing errors in the repo's own code, both fixed in the same
pass: a `react-hooks/set-state-in-effect` on `workspace-home.tsx`'s one-shot
query-string read (the documented `nav-auth.tsx` mount-effect pattern → disable comment
with a rationale) and an `any` in `provision-effects.test.ts` (→ `Record<string, unknown>`).

**So `lint` exiting 0 is now meaningful in this repo, and a new failure is genuinely
yours.** If it ever floods with errors from a path you cannot edit, add the ignore
rather than the workaround.
