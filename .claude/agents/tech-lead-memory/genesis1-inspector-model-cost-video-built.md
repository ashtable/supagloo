---
name: genesis1-inspector-model-cost-video-built
description: The genesis-1 Inspector run (2026-07-28) — a project-level aiSettings block, the first model-catalogue endpoint, an honest three-state cost estimate, per-scene video, and the trick that kept every repo green through a db-lib change
metadata:
  type: decision
---

Four features in one run: per-kind provider/model selection, faith alignment, a cost
estimate shown before the generate button, and video-per-scene. Live provider facts in
[[gloo-image-generation-live-facts]].

**All four are EXTENSIONS to a transcribed screen.** `design-delta` §2.7.1 records
inspector `13b` as transcribed, and a search of every studio turn found zero
provider/model pickers, zero `catholic`/`tradition`/`denomination`, zero
`cost`/`price`/`estimate`, and only still images. Say so; do not present them as
transcriptions.

## The decisions

**D-A — the selectors are PROJECT-level, in one new `GENERATION · whole video` section.**
A model choice configures the project, not a scene. Per-scene would make the user pick a
model 5–10 times (the opposite of "know the cost of iterating") and a per-scene
`faithAlignment` would let scene 3 argue with scene 4. Project-level → per-scene later is
an additive optional field; the reverse is a manifest migration. The `· whole video`
qualifier is 13b's OWN answer to "a project-wide setting inside a scene panel" — reuse it,
do not invent a settings drawer.

**D-D — the cost estimate returns THREE things, not a number.** The four selectable kinds
are priced four different ways and one is not priced at all, so a single number would have
to invent something for at least two of them:

| kind · provider | rule | confidence |
|---|---|---|
| image · openrouter | `pricing.image` is $/image and we buy exactly one | `measured` |
| image · gloo | per-token only, and an image's token count is unknowable in advance (system prompt alone 1042 → 14917 with `tradition`) → show the RATE, refuse a total | `unpriced` |
| narration / music | $/input token × tokens estimated from the REAL script characters | `assumed` |
| **video** | **OpenRouter publishes no video pricing at all** | `unpriced` |

Rendered `$0.0300` / `~$0.0004` / `—`. Hard rules, each its own test: a **negative** price
means variable/auto (never a number); a **zero** `pricing.image` is a "free" model that
500s in practice, so it is unpriced not free; and **video is checked FIRST, before anything
reads `pricing`** — the rule is about the kind, so no future catalogue change can turn "we
cannot know" into a confident dollar amount.

**D-C — the catalogue endpoint belongs in the api, not the BFF.** OpenRouter's catalogue is
public (the YouVersion-in-the-BFF precedent would have applied), but **Gloo's needs a
bearer minted from credentials encrypted at rest in the api's database**. That single fact
decides it. `GET /v1/ai/models` + a thin BFF passthrough that adds ONE thing the api cannot
know: `resolveGenerationTarget(kind)` defaults. That is the BFF publishing its own config,
not business logic — the same enrichment `POST /api/ai/generations` already does.

**D-E — video: request the clip at the scene's length; do NOT stretch the scene to it.**
The opposite of the narration rule, deliberately. A verse cut off mid-sentence is
semantically broken; a clip that ends early is a visual choice — and folding a third input
into `effectiveSceneDurationSeconds` risks the six mutation-pinned length functions for no
semantic gain. See [[storyboard-six-length-functions-mutation-pinned]].

**D-F — the video poll budget was a bug waiting to happen.** `generateVideo` polls
40 × 30 s = **20 minutes**; the studio's `pollGenerationUntilTerminal` defaults to **300 s**.
The UI would have reported failure while the workflow ran on, and the finished clip would
never have attached. `runGeneration` now takes an options bag; video passes 25 min.

## The trick that kept every repo GREEN through a db-lib change

`api`/`dbos` resolve db-lib through their **nested submodule** (`node_modules/@supagloo/database-lib
-> ./supagloo-database-lib`), which only moves at the release step. Faking that is
forbidden ([[in-flight-dblib-e2e-constraint]]). Rather than accept a red window:

- **dbos declares its own `tradition` vocabulary** (`providers/faith-alignment.ts`) instead
  of importing db-lib's. Not accidental duplication: db-lib's enum is the MANIFEST
  vocabulary, dbos's is the WIRE contract with Gloo. Each names the other; each is pinned
  by its own test.
- **`canonicalizeManifest` reads `aiSettings` through a locally-declared forward type**
  (`ManifestWithAiSettings`), marked for deletion at the bump. It is a structural read over
  a JSON object, so runtime behaviour is correct today.
- **The api's catalogue service takes the matrix as an INJECTED dependency** defaulting to
  db-lib's export. The RULE ("filter by whatever the matrix says") is pinned in the api; the
  VALUE (`image: ["gloo","openrouter"]`) is pinned in db-lib, where it is green now.

**There are TWO in-flight gaps, not one** (corrected 2026-07-28 by the Step 7 review — the
note previously named only the first and called it "the ONE real gap"). Both close only when
the api's AND dbos's gitlinks move; **both must move in the same release.**

**Gap #1 — the matrix.** The api's `AI_PROVIDERS_BY_KIND.image` still reads
`["openrouter"]`, so `filterByMatrix` reduces every Gloo image model to `kinds: []` and
`GET /v1/ai/models` drops them. Downstream that makes `providerOptionsFor` return
`available:false / "No models available"` and renders `ai-provider-image-gloo` disabled.

**Gap #2 — the api STRIPS `aiSettings` on every commit and every read.** Larger, and it was
missed because the four-mirror rule does not name this boundary. The api validates the
manifest DTO with the NESTED db-lib's `ProjectManifestSchema`, which is a plain `z.object`
(Zod strips unknown keys) with no `aiSettings` — and then forwards the PARSED value, not the
request:

- `jobs/project-jobs-service.ts:421` `safeParse(req.manifest)` → `:462` enqueues
  `parsedManifest.data`. Every commit.
- `manifests/manifest-service.ts:102` returns `parsed.data`. Every read.

So until the bump, **D2's persistence half has never once executed** end to end, and the
only e2e that can see it is `E-MC5` (commit + reopen).

**⇒ THE FIFTH MIRROR.** The four-mirror rule names db-lib's schema, dbos's
`canonicalizeManifest`, nextjs's `contracts.ts` and nextjs's `manifest-adapter.ts`. It does
NOT name **the api's manifest DTO validation**, which is a strip point of exactly the same
kind: a `z.object` that parses the manifest and forwards its own output. Any future manifest
field must walk five boundaries, and this is the one with no test in any repo that would go
red — the api's own suites build their fixtures from the same schema that does the stripping.

**Do not misattribute the e2e blast radius.** Only `E-MC5` is blocked by the strip. `E-MC1`,
`E-MC3` and the Gloo half of `E-MC4` are pure in-memory flows blocked by **gap #1**, the
matrix. Conflating the two sends the next reader looking for a persistence bug that is not
there.

## The four mirrors, again

`aiSettings` walks db-lib schema → **dbos `canonicalizeManifest`** → nextjs `contracts.ts`
→ nextjs `manifest-adapter.ts` BOTH directions. It is project-level, so `Scene`,
`scene-duration.ts` and `ken-burns.ts` are untouched. Held by U-AS4 (dbos, incl. a FIXED
key-order assertion for byte stability), U-AS9/U-AS10 (round-trip identity with the block
present AND absent), and E-MC5 (commit + reload, the only proof that crosses repos).

## Two latent bugs closed on the way

1. **`setSceneVisual` now REQUIRES `kind`.** `visualAssetKind` was READ by the renderer
   (`isVideo ? <OffthreadVideo> : <Img>`) and the preview but written by nothing outside
   test fixtures — harmless while the studio could not request a video, render-killing the
   moment it can. Both directions matter: `IMAGE_GENERATED` writes `"image"` explicitly, or
   rerolling a still onto a former clip sends a PNG through `<OffthreadVideo>`, which
   refuses stills.
2. **`selectGlooChatModel`'s substring heuristic** (`mini|nano|small|lite|flash|haiku`) now
   matches FOUR image models and was safe only by catalogue-ORDERING accident. Filters on
   `output_modalities.includes("text")` and sorts by real price.

## Gotchas worth keeping

- **`useOptionalSession()`** was added for this panel — the non-throwing read, for a
  component that ALREADY renders a "session not known yet" state. Without it, every studio
  component test would have to mock `session-provider`. Use it only where the null branch
  is a rendered state.
- **`contracts.ts` enum ORDERING is load-bearing.** `AiGenerationKindSchema`/
  `AiProviderSchema` had to move ABOVE the manifest block that references them: a `const`
  declared later is in the temporal dead zone — a ReferenceError at import, not a type
  error.
- Cost/rate assertions must use `toBeCloseTo`; per-1k↔per-token division is binary floating
  point and exact equality pins IEEE-754 rounding rather than the rule.

Related: [[genesis1-studio-share-bugs-built]], [[render-bugs-narration-music-kenburns-built]],
[[new-e2e-spec-joins-the-mock-lane-by-default]], [[session-resolved-vs-signed-out]].
