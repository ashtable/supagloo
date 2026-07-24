---
name: task-34-e5-youversion-real-api
description: 34-E5 corrected the dbos YouVersion client to the VERIFIED-LIVE Platform API (real routes/shapes) and flipped generate-script's passage-fetch e2e to the live host
metadata:
  type: decision
---

Task 34-E5 (dbos-only, §10.4a) replaced the YouVersion client's STUB-shaped guesses with the
**verified live** YouVersion Platform / Data Exchange contract (probed 2026-07-23 against
`https://api.youversion.com` with the real `YOUVERSION_APP_KEY`). The three prior documented
shapes each disagreed; the real API is a **hybrid** and the stub's `/data-exchange/**` routes 404.

**VERIFIED LIVE CONTRACT (ground truth — do not re-derive):**
- Auth: header `x-yvp-app-key` (case-insensitive), **REQUIRED on BOTH endpoints**. Missing/wrong
  key → `401` (a gateway OAuth check that fires *before* backend routing, so a bad key 401s
  regardless of path validity). Bodies: missing → `faultstring:"Failed to resolve API Key…"`;
  wrong → `faultstring:"Invalid ApiKey"`.
- Collection: `GET /v1/bibles?language_ranges[]=<lang>` → `{ data:[ { id:<NUMBER>, abbreviation,
  title, language_tag, localized_title, books:[USFM…], youversion_deep_link, … } ] }`. The `id`
  is a **NUMBER** on the wire. English (`eng`) returns 20 bibles; real ids: **ASV=12, BSB=3034**.
  **KJV is NOT in the app's English collection.** (`URLSearchParams` emits `language_ranges%5B%5D`
  — the live API accepts the percent-encoded form.)
- Passage: `GET /v1/bibles/<numericId>/passages/<USFM_REF>` (**PATH-based**, not a query) →
  `{ id:<usfm>, content:<text>, reference:<human "John 3:16"> }`. Text is in **`content`** (a
  single string), NOT `passages:[{text}]`. No version/translation field in the response. The
  reference **MUST be USFM** (`JHN.3.16`); a human ref ("John 3:16") → 404. Errors: bad numeric id
  → 404 "Bible version N not found"; **non-integer id (e.g. "kjv") → 422 int_parsing**; bad USFM
  → 404 "…not found"; no 400 observed.

**Client corrections (`src/providers/youversion.ts`):**
- `getBibleCollection`: route `/v1/bibles`; parse raw numeric-id entries → map with
  **`id: String(raw.id)`** (CRITICAL — a numeric id crashes `resolveTranslation`'s
  `entry.id.toLowerCase()` with a TypeError, and it must be a string path segment). `name`←`title`,
  `languageTag`←`language_tag`. `BibleCollectionEntry` kept `id:string`+`abbreviation`+`name?`
  (so `translation.ts` + its test compile verbatim), swapped `language:{iso_639_3}`/`public_domain`
  → `languageTag?`.
- `fetchPassage`: path-based `/v1/bibles/{encodeURIComponent(id)}/passages/{encodeURIComponent(ref)}`;
  parse `{id,content,reference}` → return `{reference, text:content}`. **422 →
  YouVersionUnsupportedVersionError** (its hardcoded status changed 400→422), **404 →
  YouVersionPassageNotFoundError**, other non-ok → generic `ProviderHttpError(status)`.
  `FetchedPassage` dropped `translation` (real API has none; the workflow uses `resolved.label`,
  never `fetched.translation`). Both typed error classes kept their `(version)`/`(reference)`
  ctors — `generate-script/errors.test.ts` constructs them and asserts permanence (422 & 404 both
  permanent, so that test stayed green untouched).

**OPEN QUESTION RESOLVED — `generate-script.ts` NOT touched.** The deterministic-failure req
("missing/wrong app key fails deterministically") is satisfied by the CLIENT alone: a bad key →
collection 401 (swallowed → KJV/BSB fallback) → passage fetch sends the *same* bad key → live 401
→ `ProviderHttpError(401)` → `isPermanentHttpStatus(401)` → fail-fast → `markGenerationFailed`.
The swallow-to-fallback behavior stays as designed (§9-Q10). Confirmed live: step logs
"Non-retryable error in step. Attempt 1 of 3. …401", generation → "failed", LLM step count 0.

**Tests:** `youversion.test.ts` rewritten with LIVE-captured fixtures (route/param + `content`
parse + numeric-id→string + version-id resolution via `resolveTranslation` + 401/422/404
classification). `seed-connections.ts` added `YOUVERSION_APP_KEY` to `GENERATION_SEED_ENV_VARS` +
`GenerationSeedCreds.youversionAppKey` (fail-fast if missing; +updated `seed-connections.test.ts`).
`generate-script.e2e.ts` threads the real key into `loadEnv` (YOUVERSION_BASE_URL left defaulting
real, never the stub) + a new "LIVE YouVersion" describe: passage happy-path (script kind, BSB +
USFM `JHN.3.16`, proof = succeeded + `countStepExecutions("fetchScripturePassage")===1`) and
wrong-key deterministic-failure (override `setProviderConfig({youversionAppKey:bad})` in a
try/finally). 338 unit green, typecheck clean, e2e 3/3 green (~30s, ~2 cheap OpenRouter calls;
YouVersion is free).

**RESIDUAL RISK for later steps / follow-up tasks:**
- **USFM requirement is an upstream gap.** The client now requires `scripture.reference` to be
  USFM (`JHN.3.16`). Producing USFM from a human/VOTD selection (book-name→USFM, `C:V`→`C.V`,
  ranges) is unbuilt and out of 34-E5's scope — needs a follow-up (client or upstream normalizer +
  UI/API emitting USFM). A partial converter would be worse than none.
- **`FALLBACK_VERSION_IDS={KJV:"kjv",BSB:"bsb"}` in `translation.ts` are non-numeric** → invalid
  live bible ids (422/404) → the §9-Q10 fallback is effectively broken against the real host (only
  fires on a collection-call failure; degrades to a permanent failure, not wrong data). Plus KJV
  isn't in the live eng collection. Both are §9-Q10 licensing-posture concerns, explicitly out of
  scope / untouched here — flagged for the design owners.

See [[generate-script-workflow-built]], [[task-34-e4-dbos-e2e-real-provider-generate]],
[[kjv-bsb-generation-only]], [[provider-call-layer-built]].
