---
name: openrouter-audio-live-contract-facts
description: Live-verified OpenRouter audio facts (2026-07-27) that CONTRADICT four shipped comments — the speech endpoint exists, `speech` is a separate catalogue, Lyria always returns MP3, and no music model takes a duration
metadata:
  type: reference
---

Verified against real `openrouter.ai` on 2026-07-27 with `OPENROUTER_E2E_TEST_API_KEY`.
Four claims written in the repo as "CONFIRMED" were wrong; each cost a real bug.

**1. `POST /api/v1/audio/speech` EXISTS.** `media-client.ts` asserted it did not.
Contract: `{model, input, voice, response_format}` → audio bytes as the response body.
- `voice` is REQUIRED (Zod `invalid_type` on `["voice"]` when omitted).
- `response_format` ∈ `{"mp3","pcm"}` — `"wav"` is rejected BY NAME, which is how the
  option list was discovered.
- Voice vocabularies are MODEL-SPECIFIC (deepgram enumerates `aura-2-*` in its 400 body).
- Some models are pcm-only (Gemini TTS: `only supports response_format="pcm"`).

**2. `output_modalities=speech` and `=audio` are DISJOINT catalogues.** `discovery.ts`
said "the TTS modality token is 'audio', not 'speech' — do not drift". Backwards:
- `speech` → 15 dedicated batch-TTS models, `architecture.output_modalities === ["speech"]`.
  These are the ones `/api/v1/audio/speech` accepts.
- `audio` → 4 models (2 Lyria music + 2 conversational gpt-audio), `["text","audio"]`.
- The conversational models are REJECTED by the speech endpoint (`400 Model … does not exist`).
- `output_modalities=music` returns zero — not a token.

**3. Lyria IGNORES `audio.format` and always returns ID3-tagged MP3.** Asked for
`pcm16`, `wav` and `mp3` in turn; all three came back with magic `49 44 33` = MPEG1
Layer III, **44.1 kHz stereo**, ~25–31 s. `wavFromPcm16` then declared them 24 kHz mono
PCM16, so a 29.07 s bed announced itself as `703859/(24000*2)` = 14.66 s. **That was the
whole "music ends early" bug — manufactured in our own code, zero provider variance.**
Never trust the requested format; sniff the bytes.

**4. NO music model accepts a duration.** `supported_parameters` for both Lyria models is
`["max_tokens","response_format","seed","temperature","top_p"]`. Length is a property of
the model (clip ≈ 30 s, pro = a full song), not a request parameter. So "make the bed span
the video" can only ever be the composition's job.

**Bonus — the chat path reproduces the narration bug exactly.** Posting a verse as a `user`
turn to a conversational audio model returns spoken COMMENTARY: *"It sounds like you're
quoting from the Book of Genesis…"* — 16.4 s for a 3.5 s verse. Same verse through
`/audio/speech` = 3.528 s, verbatim.

**The lesson, again:** this file's own comments were the authority nobody re-checked. See
[[youversion-signin-live-contract-facts]] for the same shape. Re-probe before trusting any
provider comment here, however emphatically it is worded.
