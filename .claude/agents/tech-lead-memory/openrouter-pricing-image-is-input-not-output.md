---
name: openrouter-pricing-image-is-input-not-output
description: OpenRouter's `pricing.image` is the per-IMAGE-INPUT-token rate, not $ per generated image — the api reads it as "$/IMAGE", so the Studio's `measured` per-image cost is wrong by ~5 orders of magnitude on the Gemini family; only 4 of 40 image models publish it at all, and none of the models the picker or R4 lands on do
metadata:
  type: constraint
---

Measured live against `GET https://openrouter.ai/api/v1/models?output_modalities=image`
on **2026-07-31** (40 image-capable models).

## The field the api reads is not the field it thinks it is

`supagloo-nodejs-api/src/ai/model-catalogue.ts` documents *"`pricing.image` is $/IMAGE"*
and maps it to `AiModelPricing.perImage`. `lib/studio/cost-estimate.ts` then renders it as
`$X per image × 1 image` with `confidence: "measured"`.

For every Gemini entry, `pricing.image` is **byte-identical to `pricing.prompt`**:

| model | `prompt` | `image` | `image_output` |
|---|---|---|---|
| `google/gemini-2.5-flash-image` | 0.0000003 | **0.0000003** | 0.00003 |
| `google/gemini-3-pro-image` | 0.000002 | **0.000002** | 0.00012 |

`image` is the **per-token rate for an image supplied as INPUT**. The field that prices a
GENERATED image is `image_output` (and `image_token`). So a run that renders
`$0.0000003 per image × 1 image` for Nano Banana is off by roughly five orders of
magnitude — and it is stamped `measured`, which is exactly the claim `cost-estimate.ts`'s
own rule ("a number we cannot defend is never shown") forbids.

## And it is almost never present anyway

Only **4 of 40** image models publish `pricing.image` at all
(`google/gemini-3-pro-image`, `-preview`, `google/gemini-2.5-flash-image`,
`x-ai/grok-imagine-image-quality`). Every other entry has `prompt`/`completion`/
`image_token`/`image_output` and no `image` key, so `estimateGenerationCost` correctly
answers "This model publishes no per-image price" → `—`.

Notably absent from the priced four: **the first entry in the catalogue**
(`microsoft/mai-image-2.5-pro`) and **R4's chosen `google/gemini-3.1-flash-image`**
("Nano Banana 2"). Both render `—`.

## Two consequences worth stating out loud

1. **`resolveChoice` lands on `modelsFor(kind, provider, catalogue)[0]`** when the user
   switches the image provider by hand, because the BFF publishes only ONE default per
   kind (the connection-resolved one). So the picker lands on OpenRouter's *first*
   catalogue entry, not on the deployment's own `DEFAULT_MODEL_BY_KIND_PROVIDER`
   answer — see [[matrix-order-is-compatibility-not-preference]] for the sibling
   "order is not preference" trap.
2. **Do not "fix" a red cost assertion by re-pointing it at a model that has
   `pricing.image`.** That makes the test green by pinning the wrong-field reading as
   correct. Either fix the mapper (read `image_output`, and say what the unit is) or let
   the row say `—`, which is currently the honest answer for 36 of 40 models.

Related: [[genesis1-inspector-model-cost-video-built]],
[[openrouter-media-and-ai-sdk-split]], [[openrouter-audio-live-contract-facts]].
