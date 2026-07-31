---
name: passthrough-ships-a-wire-field-before-the-dblib-bump
description: A TOP-LEVEL key on a `.passthrough()` input reaches dbos/api today, before the gitlink moves — the only in-flight escape that works for VALUES, not just types; plus the measured scope of the no-model-ids lint
metadata:
  type: constraint
---

## The problem this solves

`api` and `dbos` resolve `@supagloo/database-lib` through their **nested submodule**, which
only moves at the release step. So a **new db-lib VALUE export cannot be imported at all**
until the bump — `tsc` fails and the runtime import is `undefined`. The established
forward-declaration trick ([[genesis1-inspector-model-cost-video-built]]) covers TYPES,
which are erased; it does nothing for values.

That is why "put the shared table in db-lib" is often the wrong first answer: it makes the
feature unbuildable in the same run.

## The escape, measured

`GenerateNarrationInputSchema = NarrationSpecSchema.passthrough()` (db-lib
`schemas.ts`). `.passthrough()` applies to **that object's own unknown keys**. So:

- a key at the **TOP LEVEL** of the generation input **survives** an api/dbos still pinned
  to an older db-lib, end to end, today;
- a key **nested inside** `voice` does **not** — `VoiceDescriptorSchema` is a plain
  `z.object`, and Zod strips.

This is the same mechanism `studio-context.tsx` already records for `faithAlignment`:
*"every kind's input schema is `.passthrough()`, so it needs no api or db-lib contract
change."* Feature 1's `voiceId` was placed top-level for exactly this reason, and it is
worth saying so in the schema's JSDoc — otherwise the "obvious" nesting gets restored.

Read it in the consumer with a structural cast (`(input as {voiceId?: unknown}).voiceId`),
marked `DELETE AT THE db-lib BUMP`. Treat anything not a non-empty string as absent rather
than forwarding it: an unknown provider voice is a hard 400, and degrading to the default
beats failing the generation.

**When you come back to honour that marker, read
[[passthrough-exempts-only-undeclared-keys]] first.** The cast and its runtime guard do NOT
have the same fate: `.passthrough()` exempts only UNDECLARED keys, so once db-lib declares
the field Zod validates it and the guard is provably dead — but a marker whose field the
bump did NOT declare (measured: `narratorVoice` on `GenerateScriptInputSchema`) keeps a
guard that is the only shape check there is, and its "DELETE AT THE BUMP" promise is false
and must be rewritten. Measure each marker with `tsc --noEmit`; do not sweep them as a batch.

**The manifest half still walks all five mirrors** ([[the-manifest-has-five-mirrors-not-four]]).
Only the WIRE half escapes. Say which half you mean.

### "Blocked until the bump" is the WRONG WORD for the manifest half — it is ERASED ON COMMIT

Corrected 2026-07-29 after measurement. "Blocked" reads as *the value does not arrive yet*,
which is benign and wrong. What actually happens is worse and is a live data-loss bug:

- The scaffold seeds the field **past the schema** (`api/src/jobs/project-jobs-service.ts`
  casts via `seedManifestScripture`; `dbos` `scaffold-project.ts` writes `payload.manifest`
  with no runtime parse), so a fresh repo **already contains** the value.
- Every read/write boundary that has not been updated then **deletes it**: the studio's
  `ManifestResponseSchema.safeParse` strips it on read, and `serializeManifest` — which
  builds its result field-by-field with no `...base` spread — omits it on write. The next
  Commit writes the user's own repo back without it.

So the honest sentence is **"erased on commit"**, never "does not persist end-to-end" and
never "blocked until the bump".

### And "it heals at the bump" is false for the nextjs mirrors

nextjs **never imports `@supagloo/database-lib`** — one repo-wide reference, the comment at
`lib/api/contracts.ts:8`; the vendored submodule is excluded from `tsconfig.json` and
`eslint.config.mjs`. Its two mirrors (`lib/api/contracts.ts`, `lib/studio/manifest-adapter.ts`)
are **hand-written copies that no gitlink can fix**, and bumping nextjs's own db-lib pin
buys literally nothing. `scripture`'s nextjs mirrors were closed by hand-written code in
this run, not by the release; only the ROOT gitlink to that nextjs commit carries the fix.
`narratorVoice.voiceId` is the contrasting case — five complete mirrors, so it genuinely
does heal once db-lib, api and dbos move.

Rule: before writing "heals at the bump" about any manifest field, check whether each
mirror **imports** db-lib or **copies** it. Only importers heal.

## The api's route-level version of the same move

`POST /v1/projects` validates with db-lib's `CreateProjectRequestSchema`, so a new field is
**silently stripped** — the client gets its 201 and the value is gone. Fix:
`CreateProjectRequestSchema.extend({ scripture: LocallyDeclaredSchema.optional() })` in the
route. That makes a malformed value a loud 400 instead of a quiet drop, and it collapses to
a no-op re-declaration at the bump. A test must drive the real HANDLER, not the schema —
the schema under test is the one doing the stripping.

## Where the `no-model-ids` lint actually reaches (measured, not assumed)

`dbos/src/providers/no-model-ids.test.ts` does `readdirSync(__dirname)` filtered to
`*.ts` minus `*.test.ts` — i.e. **`dbos/src/providers/` only, NON-recursive**.
`src/workflows/**` is entirely out of scope. The invariant it protects is that nothing
FREEZES A MODEL CHOICE into a call path; a lookup table keyed BY model id that selects no
model does not violate it. Do not assume the lint is repo-wide, and do not route around it
by moving a file when the rule was never about that file.

Related: [[in-flight-dblib-e2e-constraint]], [[the-manifest-has-five-mirrors-not-four]].
