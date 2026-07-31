---
name: voice-catalogue-must-be-provider-sourced
description: The curated per-model narrator-voice table was wrong for EVERY model it covered, and an undocumented OpenAI→Kokoro alias layer hid it — plus the three strip points `supported_voices` dies at, and why the dbos default voice is now discovered rather than constant
metadata:
  type: decision
---

Built 2026-07-30. `nextjs/lib/studio/speech-voices.ts` held a curated table
(`ORPHEUS`/`GROK`/`OPENAI` + `FALLBACK`) whose own header argued a hardcoded list was "the
only option" because "no provider publishes a voice-enumeration API".

**That claim was false and the table was wrong for every model it claimed to cover.**
`GET https://openrouter.ai/api/v1/models?output_modalities=speech` carries a **top-level
`supported_voices`** array on every entry and **answers unauthenticated**. There is no
`openai/*` entry in that catalogue at all — so `FALLBACK = OPENAI` matched nothing real and
*every* live speech model fell through to a list none of them declare.

**The alias layer is what hid it.** Against `hexgrad/kokoro-82m`, measured live: `alloy`,
`onyx`, `echo`, `fable`, `nova`, `shimmer` all return **200** via an undocumented
OpenAI→Kokoro alias, while `ash` and `sage` **hard-400 the whole generation**. Byte-size
clusters put `alloy`→`af_alloy` and `shimmer`→`af_nova` — both American **FEMALE**. That is
the entire user report ("the same female voice for Alloy and Shimmer"), with a **perfectly
working `voiceId` wire**. A silent alias is worse than a rejection: six of eight picks
"worked", so nothing ever reported the mismatch.

⚠️ **The empty state is JSON `null`, not `[]`** — 6 of 19 speech models (all `fish-audio/*`,
both `minimax/*`). An empty array never occurs live, so keep the two distinguishable.

## Three strip points, and the api already had the bytes

`api/src/ai/model-catalogue-service.ts` had been fetching that exact catalogue and
discarding the key. `supported_voices` dies at exactly three plain-`z.object` boundaries:

1. `api/src/ai/model-catalogue.ts` — the mapper (`RawOpenRouterSpeechModel`, `AiModelInfo`)
2. `api/src/ai/model-catalogue-dto.ts` — **the Fastify RESPONSE serializer**, the classic
   miss; widening the service without this yields nothing on the wire, silently, with every
   service-level test green
3. `nextjs/lib/api/contracts.ts` — the hand-mirrored copy

No BFF edit (`app/api/ai/models/route.ts` spreads verbatim) and **no db-lib change**.

**Deliberate asymmetry:** the api's DTO is `.nullable()` (strict — the mappers are the only
writers, so a missed one is a compile error); nextjs's is `.nullable().default(null)`
(tolerant). They deploy independently, and a required field against an older api fails the
whole `safeParse`, which `fetchModelCatalogue` turns into `null` — the entire picker would
vanish rather than one field being absent. Strict on output, tolerant on input.

## Parsing a convention is permitted; asserting ids is not

`supported_voices` entries are plain strings for all 13 voice-bearing models — there is **no
structured language or gender metadata anywhere** on the catalogue (`architecture`,
`supported_parameters`, `default_parameters` all checked). Kokoro's `[lang][gender]_name` is
strict enough not to fire on any other model's convention (`american_female`, `en_paul_sad`,
`aura-2-thalia-en`, `Zephyr`, `conversational_a` all fail to parse), and an unparseable
vocabulary degrades to a `—` group that still lists every id. A test scans the shipping
source for voice ids — **with comments stripped**, so the header can still explain the
deleted table.

## `DEFAULT_NARRATION_VOICE` is deleted, not replaced

It was load-bearing (omitting `voice` is a hard 400: *"An explicit voice is required for this
TTS provider."*) **and** wrong (`alloy` is not in Kokoro's 54). Substituting `am_adam` would
have reintroduced the exact anti-pattern being deleted. So `requestSpeech` now resolves the
**model's own first published voice** from that same catalogue when the caller names none,
TTL-cached per base URL, and throws a retryable **502** rather than guessing. Both callers
(`generate-audio/synthesize.ts`, `render/audio.ts`) leave `voice` `undefined` — "both sites
or neither" now holds by delegation rather than by two constants agreeing.

## The display and the wire must be ONE function

`effectiveVoiceId(selected, voices)` answers both "what the picker reads as selected" and
"what `regenerateNarration` sends". The shipped code had `selected = selectedVoiceId ??
recommended` for display and omitted `voiceId` from the request when nothing was picked —
two answers to one question, only one audible. It deliberately does **not** write to the
manifest: a default frozen into the user's committed repo stops being a default.

`MODELS_LOADED` is the one action that must re-check the voice (it is when the vocabulary
first becomes knowable) and it must **not dirty** — but it should still CLEAR an invalid id,
or that id rides into the user's repo on their next unrelated commit.

Related: [[openrouter-audio-live-contract-facts]] (same shape — this file's own comments were
the authority nobody re-checked), [[the-manifest-has-five-mirrors-not-four]],
[[passthrough-ships-a-wire-field-before-the-dblib-bump]],
[[e2e-cascade-select-needs-the-option-not-the-element]].
