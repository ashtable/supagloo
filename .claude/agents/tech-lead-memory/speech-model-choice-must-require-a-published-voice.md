---
name: speech-model-choice-must-require-a-published-voice
description: The e2e narration chooser sorted the live speech catalogue by price and returned [0] — but 6 of 19 live models publish no `supported_voices` and the product deliberately refuses those, so a new FREE voice-less model upstream reds two lanes with zero repo change
metadata:
  type: constraint
---

Found 2026-07-31, fixed in dbos `8051ea2`.

## The rule

**A model selected for `POST /api/v1/audio/speech` must publish a voice.** That endpoint
requires one, and `src/providers/media-client.ts`'s `defaultVoiceFor` *deliberately* throws
a retryable 502 — `the speech catalogue publishes no voices for "<id>", and this endpoint
requires one` — rather than guess. Its docblock states the trade: a genuinely voice-less
model must fail visibly instead of narrating in a voice nobody chose (see
[[voice-catalogue-must-be-provider-sourced]]). So "cheapest" was never the selection rule;
**cheapest USABLE** is.

`src/testing/e2e-models.ts`'s `selectNarrationModel` sorted by price and returned `[0]`,
with `supported_voices` not even declared on its `RawAudioModel`. It could therefore hand
the product a model the product is designed to reject.

## Why it detonated with no commit

Measured live, `GET https://openrouter.ai/api/v1/models?output_modalities=speech`:
**19 models, SIX of which publish no vocabulary** — `fish-audio/s2.1-pro-free:free`,
`fish-audio/s1`, `fish-audio/s2-pro`, `fish-audio/s2.1-pro`, `minimax/speech-2.8-turbo`,
`minimax/speech-2.8-hd`. The first is a `:free` model, so its price is **0**, so it sorted
**first**. Both narration lanes then burned their whole DBOS step-retry budget:

- `generate-audio.e2e.ts` — `synthesizeNarrationScene:s1` exceeded its max of 4 retries
- `render.render.e2e.ts` — `ensureNarrationAudio` exceeded its max of 3 retries

**A price-ordered pick over a provider-controlled list is a live-drift landmine**: anyone
publishing a cheap or free entry that misses a precondition you did not encode silently
becomes your default. Encode the precondition in the selector, not in a comment.

The cheapest model that DOES publish voices is `hexgrad/kokoro-82m` (6.2e-7/token, 54
voices) — an order of magnitude below the next priced tier, so requiring a voice made the
lane *cheaper*.

## What the fix is (and is not)

Harness-only: `AudioModelInfo.voiceCount`, populated by `toAudioModelInfo` from the SAME
endpoint response the product's `readSpeechVoices` parses (absent/`null` ⇒ 0, a real live
state), and `selectNarrationModel` filters `voiceCount > 0` with a distinct throw for
"catalogue publishes no vocabulary" vs "catalogue empty". **No product change** — the
refusal is correct. `selectAudioModel` (the `audio`/music catalogue) deliberately does NOT
filter: music models have no voices.

`selectNarrationModel` had **zero** unit coverage before this; that gap is why price-only
selection shipped. It now has a regression case built from the measured live shape plus a
control proving the cheapest is still chosen when every candidate publishes voices — without
that control the filter could pass by flipping every answer
([[an-anti-vacuity-control-belongs-after-the-loop]]).

## How it stayed hidden

Both affected specs **failed to COLLECT** for a day — they were casualties of
[[e2e-env-literals-each-copy-the-required-set]]. One breakage masking another is the normal
case, not a surprise: a lane that does not run cannot report anything, so the first green
run after a collection failure should be treated as a *first* run, not a regression check.

Related: [[openrouter-audio-live-contract-facts]], [[voice-catalogue-must-be-provider-sourced]].
