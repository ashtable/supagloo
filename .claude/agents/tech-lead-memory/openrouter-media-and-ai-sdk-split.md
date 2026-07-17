---
name: openrouter-media-and-ai-sdk-split
description: Confirmed 2026-07-17 — OpenRouter alone covers video/TTS/music; AI SDK generateObject for structured text, plain fetch for media; never hardcode model ids
metadata:
  type: decision
---

**OpenRouter alone covers all media modalities** (no third provider):

- Video: `POST /api/v1/videos` — async job pattern: 202 with
  `{ id, polling_url, status: "pending" }`; poll ~30s through
  `pending → in_progress → completed`; download via
  `GET /api/v1/videos/{jobId}/content?index=0`. The provider job id is
  persisted to `AiGeneration.providerJobId` in the submit step so DBOS
  replay/polling survives worker crashes without re-submitting.
- TTS: `POST /api/v1/audio/speech` (OpenAI Audio Speech-compatible;
  response is a raw audio byte stream + `X-Generation-Id` header, not
  JSON). Preferred over the chat-completions audio-modality path (which
  mandates streaming + base64 SSE chunks; built for conversational voice).
- Music: music-capable models exist; concrete model/endpoint resolved at
  implementation time via discovery.

**Call-pattern split:** structured text (storyboard/script) uses the Vercel
AI SDK `generateObject` + Zod via an OpenAI-compatible provider wrapper;
media generation calls OpenRouter REST **directly with `fetch`** — the
async-job and byte-stream patterns don't fit AI SDK primitives.

**Hard rule:** model ids are never hardcoded — always looked up via
`GET /api/v1/models?output_modalities=…` / `GET /api/v1/videos/models` at
implementation time.

**Enforced kind→provider matrix (added 2026-07-17).** Because Gloo has **no
media modalities**, `AiGeneration.provider` is constrained per `kind`:

- `storyboard` / `script` → `gloo` **or** `openrouter` (structured text via
  AI SDK `generateObject`)
- `image` / `narration` / `music` / `video` → **`openrouter` ONLY**

The matrix is a **shared `database-lib` constant** (single source of truth) and
is **enforced at enqueue**: `POST /v1/ai/generations` rejects an out-of-matrix
`{kind, provider}` pair with **422 before any row or workflow is created**.
