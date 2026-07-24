---
name: e2e-live-provider-call-surface
description: Empirical live provider-call inventory of a full e2e run (dbos+api) + the non-invasive global-fetch setupFile technique used to capture it
metadata:
  type: reference
---

Captured 2026-07-24 by instrumenting a **temporary** global-`fetch` logger via Vitest
`setupFiles` (a `tests/e2e/provider-call-logger.ts` that patches `globalThis.fetch`,
appends JSONL, then is reverted — NOT committed). It works because every provider client +
the AI SDK resolve the global `fetch` at CALL time (`fetchImpl ?? fetch`, no module-level
capture, no workflow injects a custom fetch) and setupFiles run before the test module graph
is imported. This is the reusable way to observe real outbound calls now that 34-E8 deleted
all stub call-counting — keep it test-only + non-invasive (clone-only response peek, gated to
JSON GETs so media byte streams / SSE are never buffered).

**A full live e2e run (all suites, incl. the paid media suites) is GREEN against the real
providers** (dbos 27/27, api 61 pass + 1 loud-skip). The complete provider-call surface it
exercises — useful as a cost/regression baseline and as proof of the "resolve model ids via
discovery, never hardcode" property:

- **OpenRouter** (`openrouter.ai`): `GET /api/v1/models?output_modalities={text,audio,image}`
  + `GET /api/v1/videos/models` (discovery); `POST /api/v1/chat/completions` for ALL of text
  (structured json_schema), image (`modalities:[image]`), audio (`modalities:[text,audio]`,
  `stream`); `POST /api/v1/videos` (202) → `GET /api/v1/videos/{id}` poll loop →
  `GET /api/v1/videos/{id}/content?index=0` download (auth'd, returns mp4 200 — the 34-E4
  download fix works live end-to-end, both clips); `GET /api/v1/credits` (api credits proxy).
- **Gloo** (`platform.ai.gloo.com`): `POST /oauth2/token` (client_credentials mint; verify-fail
  test yields a real 400), `GET /platform/v2/models` (catalogue discovery),
  `POST /ai/v2/chat/completions` (structured chat).
- **YouVersion** (`api.youversion.com`): `GET /v1/bibles?language_ranges[]=eng` (collection) +
  `GET /v1/bibles/{id}/passages/{ref}` (passage). No model concept. generate-script.e2e's
  wrong-key deterministic-failure test produces the 401 pair (collection 401 → passage 401 →
  fail-fast), matching [[task-34-e5-youversion-real-api]].

Discovery-resolved model ids actually used this run (never hardcoded): OpenRouter text
`google/gemma-4-26b-a4b-it:free`, image `google/gemini-2.5-flash-image`, TTS
`openai/gpt-audio-mini`, music `google/lyria-3-clip-preview`, video `alibaba/wan-2.7`; Gloo
`gloo-google-gemini-2.5-flash-lite`. (These drift over time — the POINT is they come from
`/models` discovery, not literals.)

**Pre-existing gap (NOT this task's scope):** root Compose e2e aborts at globalSetup — the
containerized `api` service requires `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET`
(`z.string().min(1)` in api `src/config/env.ts`) which are set NOWHERE in any root
`docker-compose*.yml` and there is no root `.env`, so `supagloo-api-1` boots then immediately
exits → "Compose stack did not become ready within 150s" → ALL root e2e files blocked (they
share one globalSetup gating on the api container). Wiring those two vars into the root api
service env (or a root `.env`) is the fix; deliberately left alone here.

See [[task-34-e8-harness-simplification]], [[task-34-e4-dbos-e2e-real-provider-generate]],
[[provider-call-layer-built]].
