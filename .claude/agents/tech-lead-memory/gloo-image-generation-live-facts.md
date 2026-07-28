---
name: gloo-image-generation-live-facts
description: Gloo DOES generate images (11 models, via POST /ai/v2/responses with base64 output) but has NO speech/music/video — plus the `tradition` vocabulary whose four values are NOT server-validated, so a wrong one returns 200 and silently degrades
metadata:
  type: reference
---

Measured against `https://platform.ai.gloo.com` on **2026-07-28**, not read from docs.
Several of these contradict shipped comments in this codebase; the corrections landed with
the genesis-1 Inspector work ([[genesis1-inspector-model-cost-video-built]]).

## Images: YES — but not through chat/completions

`design-delta` §9-Q2's "Gloo has no media modalities" was **false for image**. The
catalogue carries **11 image-capable models** (6 image-only, 5 text+image) out of 106.

The reason four milestones went by without noticing: image models are **unreachable
through `/ai/v2/chat/completions`**, the only Gloo surface this system ever called. That
endpoint answers:

> 400 `Model '…' does not support text output and cannot be used with the Chat Completions
> API. Use the POST /v2/responses endpoint instead.`

**`POST {root}/ai/v2/responses`** with `{"model": …, "input": "<prompt string>"}` → 200,
~764 KB. The bytes come back **INLINE as base64**:

```
output[0] = { type: "image_generation_call", status: "completed", result: "<base64>" }
```

Verified by decoding to a valid 1024×768 8-bit RGB PNG matching the prompt, twice. A bare
`input` string, **not** a `messages` array. No URL to download afterwards — which is what
lets the workflow generate and upload inside ONE DBOS step (the bytes-never-checkpointed
fold).

## Speech / music / video: genuinely absent — and provably so

Zero catalogue entries match `audio|speech|tts|voice|narrat|music|video`.
`/ai/v2/audio/speech`, `/ai/v2/audio/transcriptions`, `/ai/v2/videos/generations` all
answer **404 (route absent)**, not 405 (route exists, wrong method). Gloo's backend is
FastAPI, so 405-vs-404 cleanly separates the two — **that is what makes these negatives
evidence rather than an absence of evidence**. `modalities:["text","audio"]` returns 200
with `message.audio` simply missing; invented ids return `Unknown model`.

⇒ `openrouter`-only is **correct** for narration/music/video, not merely cautious.

## `tradition` — the faith-alignment field, and its trap

Top-level JSON body field on `/ai/v2/chat/completions` **and** `/ai/v2/responses`.
Accepted vocabulary is exactly:

    evangelical · catholic · mainline · not_faith_specific

**THERE IS NO `protestant` AND NO `orthodox`.** `evangelical` and `mainline` are the two
Protestant-family values.

Measured by injected system-prompt size (prompt `"hi"`, `max_tokens:1`, `temperature:0`):

| `tradition` | prompt_tokens |
|---|---|
| omitted | 757 |
| `not_faith_specific` | 757 |
| `catholic` | 11253 |
| `evangelical` | 11289 |
| `mainline` | 11275 |

**THE TRAP: the enum is NOT enforced server-side.** `orthodox`, `protestant`, `reformed`,
`pentecostal`, `buddhist`, `null` and a garbage sentinel **all return 200** and silently
collapse to the 757-token neutral baseline. There is no 422 and nothing in the response
envelope distinguishes honoured from ignored. So the failure mode of a wrong value is not
an error — it is a video that quietly is not faith-aligned. **Validate on our side or not
at all.** It also applies on the image path (`input_tokens` 1042 → 14917).

Case-insensitive on the wire, but we send only canonical lowercase so the persisted value
and the wire value cannot disagree about their own vocabulary.

## Pricing: present on 106/106

Refutes `dbos/src/testing/e2e-models.ts`'s "no reliable per-model pricing". Decimal
**strings**:

```
pricing.input.rate_per_1k_tokens  /  .rate_per_1m_tokens
pricing.output.rate_per_1k_tokens /  .rate_per_1m_tokens
pricing.cache_read.…                 (subset only)
```

Responses also carry runtime `usage.cost` (e.g. `0.002508165`) with a `cost_details`
breakdown. Normalize to **per token** before comparing with OpenRouter, or the two are
silently 1000× apart.

## Other verified request facts

- Catalogue is `GET /platform/v2/models` (bearer). **`GET /ai/v2/models` is 404** despite
  Gloo's own error text citing it. `GET /ai/v1/models` exists but is a leaner
  OpenAI-shaped view with **no** modalities and **no** pricing.
- Routes confirmed by 405-vs-404: `POST /ai/v{1,2}/chat/completions`,
  `POST /ai/v{1,2}/responses`.
- Non-OpenAI body fields: `model`/`model_family`/`auto_routing` (at least one required —
  an empty body 422s), `tradition`, `prompt_cache_key`, and an `X-Cache-TTL` header
  (`5m`|`1h`; `99z` → 400).
- **Unknown body fields are silently ignored (200)** — so probing can never prove a
  field's absence.
- Gloo serves **no OpenAPI document** anywhere (`/openapi.json`, `/docs`, `/redoc`,
  `/platform/v2/openapi.json`, … all 404).
- Token mint: `POST /oauth2/token`, HTTP Basic `clientId:clientSecret`,
  `grant_type=client_credentials&scope=api/access`, `expires_in: 3600`.

Related: [[openrouter-audio-live-contract-facts]],
[[genesis1-inspector-model-cost-video-built]].
