---
name: wizard-passage-must-travel-as-usfm
description: `ScripturePassageRequestSchema.reference` is a USFM id, not a human reference — the field NAME hid that, and the studio's per-scene rewrite had been failing every generation in production because of it; the fix sends `manifest.scripture.passageId`
metadata:
  type: decision
---

Fixed 2026-07-30 in the wizard-redirect / scripture-carry-through run.

## The two defects, and why only one had been reported

**Reported:** creating a project with NIV11 / Psalms / 23 and then generating a storyboard
produced Genesis 1 in ASV. Cause: `generateStoryboard` looked for its scripture in
`manifest.scenes[0]`, which is `undefined` on a fresh scaffold, so it POSTed `{brief}` with
**no `scripture` key**. The workflow's `fetchScripturePassage` step is presence-gated → it
was skipped → `passage` stayed `null` → but the system prompt still said *"Break the passage
into an ordered sequence…"* and `StoryboardSceneSchema` **requires** a per-scene `reference`
+ `translation`. The model had to emit something. **There is no hardcoded Genesis/ASV
anywhere in the four repos** — it was the absence of an input. Fix the input; do not hunt a
constant.

**Unreported, and already live:** `sceneScriptureContext` fed `ManifestScene.reference` — a
HUMAN string — into `scripture.reference`, which dbos passes verbatim to a passage endpoint
that only accepts USFM. That is a 404 → permanent uncaught `YouVersionPassageNotFoundError`
→ the whole generation fails. So **every** "rewrite this line" against a real project was
broken, on a path whose only test seeded `"JHN.3.16"` and therefore could never see it.

## The decision: overload `reference` with the USFM; do NOT add a nested `passageId`

`ScripturePassageRequestSchema.reference` was *already effectively* USFM — its only consumer
is `fetchPassage`, whose parameter doc says so, and the dbos e2e seeds `"JHN.3.16"`. The
producer simply wasn't honouring the consumer's contract.

**Why not add `passageId` to that schema (the obvious alternative):** the api validates the
generation `input` at its Fastify boundary with `CreateAiGenerationRequestSchema` →
`GenerateScriptInputSchema`, and `scripture` there is a plain `z.object`. A **nested** field
is therefore stripped until the api's db-lib gitlink moves — the
[[the-manifest-has-five-mirrors-not-four]] failure verbatim. `.passthrough()` only saves
TOP-LEVEL keys ([[passthrough-ships-a-wire-field-before-the-dblib-bump]]). Overloading
`reference` ships today with no wire change at all.

**Trade-offs:** the field name stays ambiguous (mitigated with an explicit JSDoc in db-lib
naming the 404 and the accepted forms) and a future producer could still pass a human string
(mitigated by `projectScriptureContext` being the only builder, plus a live e2e that sends
three human references and asserts the typed 404).

## The shape that replaced it

`projectScriptureContext(manifest)` (`nextjs/lib/studio/manifest-adapter.ts`) →
`{reference: scripture.passageId, translation, language: scripture.language ?? "eng"}`, and
**`undefined` when there is no `passageId`.**

- **PROJECT-scoped, necessarily.** `ManifestScene` has no `passageId`; only the project's
  `scripture` block has one. It is also the right scope on its own terms — a storyboard
  re-plan replaces `scenes` wholesale, so anything stored there is destroyed by the very
  action that most needs the origin passage.
- **No USFM ⇒ no `scripture` block, and the reference travels in the BRIEF as prose.**
  §9-Q10 forbids silent substitution; a human string in that field is a guaranteed hard
  failure; constructing a USFM is closed. Naming it in prose is the only honest degradation.
- Both call sites go through pure builders in `nextjs/lib/studio/generation-input.ts`
  (`storyboardGenerationInput`, `scriptGenerationInput`) rather than being assembled inline
  in `studio-context.tsx`. Which values travel is a pure question, and the React wiring was
  never what was wrong.

## What did NOT have to change

`hydrateStoryboard` still does **not** put `scripture` on the UI `Storyboard` (`U-A29` stays
green): reading `project.manifest` at the call site means mirror 7 never moves. The
`ManifestScriptureSchema` mirror walk is **zero sites** for verse ranges too — `passageId`
and `reference` are existing `z.string().min(1)` fields whose *values* just got richer.

Related: [[youversion-verse-range-is-echoable]], [[studio-ai-wiring-followups]] (which
introduced `sceneScriptureContext`), [[wizard-ready-card-redirect-needs-a-confirmed-slug]].
