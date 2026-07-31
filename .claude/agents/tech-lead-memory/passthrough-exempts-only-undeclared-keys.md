---
name: passthrough-exempts-only-undeclared-keys
description: Zod's `.passthrough()` skips validation ONLY for keys the schema does not declare — so at a db-lib bump a forward-declaration's runtime guard becomes dead for a now-DECLARED field but stays load-bearing for an undeclared one; measure, never assume
metadata:
  type: constraint
---

Measured 2026-07-30 against dbos' pinned db-lib `fc5cf2c` (zod 4.4.3), while deleting the
narrator-voice run's `DELETE THE CAST AT THE db-lib BUMP` markers.

## The fact

`.passthrough()` (Zod 4's `z.looseObject`) exempts **only the keys the schema does not
declare**. A declared key is validated exactly as it would be on a strict object; passthrough
changes nothing about it. Both halves measured on the real pinned copy:

| schema | key | `safeParse` with a hostile value |
|---|---|---|
| `NarrationSpecSchema.passthrough()` | `voiceId` — **declared** `z.string().min(1).optional()` | `123` → `invalid_type`, `null` → `invalid_type`, `""` → `too_small`. **All rejected.** |
| `GenerateScriptInputSchema` = `{brief, scripture?}.passthrough()` | `narratorVoice` — **undeclared** | `12345` survives verbatim; `{description: 99}` survives verbatim. **Nothing rejected.** |

Type side: the inferred type of a passthrough object carries an index signature typed
**`unknown`, not `any`** (verified with a deliberate `const bad: string = input.someKey` probe
→ TS2322). So a parameter can be narrowed from `unknown` to the real input type and still
read an undeclared key — you get `unknown`, which is the truth, and the outer cast goes away
without buying any shape checking.

## Why it decides a guard's fate

The forward-declaration pattern ([[passthrough-ships-a-wire-field-before-the-dblib-bump]])
pairs a structural cast with a runtime guard like
`typeof raw === "string" && raw.length > 0`. **At the bump those two have opposite fates and
the difference is entirely whether db-lib now DECLARES the field:**

- **Declared** (e.g. `NarrationSpecSchema.voiceId`, `VoiceDescriptorSchema.voiceId`) — the
  guard is **dead**. Zod rejects the bad values upstream, so no reachable input can make it
  fire, which also makes it unfalsifiable by any test. Remove it with the cast.
- **Undeclared** (e.g. `narratorVoice` on `GenerateScriptInputSchema` — the bump landed and
  did **not** add it) — the guard is the **only** shape check that exists. Keep it, and
  rewrite the marker: "DELETE AT THE db-lib BUMP" is a promise no release will keep.

Deadness also needs the second half: trace that the consumer only ever receives
**parse output**. Both narration sites qualify — `parseAudioRequest` for the generation path,
`readManifest`'s `ProjectManifestSchema.safeParse` (`render/workspace.ts`) for the render
path. Without that trace the schema argument proves nothing.

Distinguish **presence** checks from **type** guards: `if (voiceId !== undefined)` in
`canonicalizeManifest` is the omit-unset-optionals rule that keeps the on-disk form
byte-stable, not a type guard. It stays regardless.

## Also: a forward cast in a TEST is worse than untidy

`manifest-json.test.ts` built its fixtures through `as ProjectManifest`. That made them
**unfalsifiable** — a field renamed or dropped upstream would have kept compiling and the
test would have gone on asserting a key nothing produces. Proven by mutation: after removing
the cast, misspelling `voiceId` in the fixture is `TS2561`; before, it was silent. Sweep test
files for the same markers, not just `src/`.

Related: [[in-flight-dblib-e2e-constraint]], [[the-manifest-has-five-mirrors-not-four]].
