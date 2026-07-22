---
name: generate-script-workflow-built
description: Task 30 built generateScriptWorkflow — the FIRST ai-generation DBOS workflow (storyboard + script structured text), the repair-loop + schema-by-kind pattern the other generation workflows (#32–34) follow; also broadened TranslationSchema per §9-Q10
metadata:
  type: reference
---

Built 2026-07-21 (plan task 30) — the FIRST `ai-generation`-queue workflow, on top of the
task-29 provider layer ([[provider-call-layer-built]]). Plan doc:
`supagloo/scratch/task-30-generate-script-workflow.md`. Design authority: design-delta §7
workflow 5, §6d diagram (d), §9-Q10, §2.8/§2.11. All GREEN against the real, released,
submodule-pinned database-lib (`e6e1de4`) — an initial pass used a local symlink override
to fake this and was WRONG; see [[in-flight-dblib-e2e-constraint]]'s 2026-07-22 correction
for the actual required sequence (release db-lib → bump+rebuild the submodule → sync the
Dockerfile ARG → only then test).

**Shape.** `src/workflows/generate-script.ts` registers `generateScript` (queue
`ai-generation`) — handles BOTH text kinds (`storyboard`→`GeneratedStoryboardSchema`,
`script`→`GeneratedScriptSchema`), schema selected by the row's `kind`. `workflowID ===
AiGeneration.id`; payload is a minimal `{generationId}` echo (everything read from the row).
Steps: loadRequestAndCredentials → optional fetchScripturePassage → callLlmStructured (+ repair
loop) → persistResult. Helpers in `src/workflows/generate-script/`: `errors.ts`,
`schema-selection.ts`, `translation.ts`, `prompt.ts`, `repair.ts`, `finalize.ts`. It ONLY
writes the `AiGeneration` row (status/resultJson/tokenUsage/completedAt) — NEVER
`ProjectVersion` or the manifest (§6d step 8; that's the separate task-21 commit workflow).

**THE repair-loop crash-safety design (reusable for every structured-gen workflow).** The
bounded re-prompt loop (max 3 repairs = up to 4 attempts) is a pure `runStructuredWithRepair`
over an INJECTED `attempt(prompt,i)` (unit-testable without LLM/DBOS). The real `attempt` is a
registered `callLlmStructured` DBOS step that **catches `NoObjectGeneratedError` INSIDE the step
and returns a `{ok:false, validationText}` UNION** instead of throwing — so a schema-validation
failure is a *successful* checkpointed step return, not a step error. Consequence: EVERY attempt
(good or bad) is checkpointed, so on crash/replay after a successful repair, all attempts replay
from checkpoints with ZERO extra LLM HTTP calls (proven via the stub's `chatCompletions` counter
staying flat across cancel→resume). HTTP `APICallError`s still THROW → step-level retry via
`LLM_STRUCTURED_RETRY` (task-29's `maxAttempts:5` backoff, 4xx fail-fast). This sidesteps any
"does DBOS checkpoint a thrown-and-caught step error" question entirely.

**Secret handling.** loadRequestAndCredentials VERIFIES the provider connection exists (fail
fast with the typed *NotConnectedError*) but returns NO plaintext. The OpenRouter key /
Gloo-minted token are (re)loaded INSIDE each LLM step so they NEVER land in a DBOS checkpoint —
unlike the git-ops workflows which DO checkpoint the ~1h GitHub installation token (acceptable
for a short-lived token; the OpenRouter key is long-lived, so plaintext-in-checkpoint is
avoided). Re-decrypt/re-mint per attempt is cheap.

**Failure path** mirrors `import-project.ts`: single outer try/catch runs a `recordFailure` step
(status `failed`) ONLY when `isPermanentGenerationFailure(err)` (repair-exhausted / not-licensed
/ unsupported-kind / not-connected / permanent 4xx) — transient AND **DBOS cancellation** are
left to propagate (cancellation is NOT one of the typed permanent errors, which is what makes the
crash/replay test safe).

**§9-Q10 TranslationSchema BROADENED (cross-task, design-mandated).** Loosened db-lib
`TranslationSchema` from `z.enum(["KJV","BSB"])` → `z.string().min(1)` (any non-empty licensed
abbreviation; the licensed set is validated at RUNTIME against the live "Get a Bible collection"
call, not the schema). Supersedes [[kjv-bsb-generation-only]]. **Blast radius (all flipped to the
new policy):** task-7 `schemas.test.ts` (Translation/ManifestScene/StoryboardScene now accept
NIV, reject only empty), the tsc-gate `tests/typecheck/schemas.type-assert.ts`, and **task-21
`commit-version-schemas.test.ts`** (commit now ACCEPTS a non-KJV/BSB manifest at the boundary —
a real semantic change to task-21's contract). ManifestScene translation is now free-form too
(§2.11: the manifest carries whatever the user selected).

**db-lib additions** (`~/code/supagloo-database-lib`): `schemas.ts` — `GeneratedScriptSchema`
(the scripture triple `{scriptText, reference, translation}` — single-scene text, no
visual/duration fields), `GenerateScriptInputSchema` (`{brief, scripture?}` `.passthrough()` so
#31's richer enqueue contract can extend it), `ScripturePassageRequestSchema`
(`{reference, translation, language(default "eng")}`), `GenerateScriptPayloadSchema`.
`workflows.ts` — `GENERATE_SCRIPT_WORKFLOW_NAME="generateScript"`,
`AI_GENERATION_QUEUE_NAME="ai-generation"`, `AI_GENERATION_WORKFLOW_BY_KIND` (storyboard+script;
media kinds land in #32–34). Registry/runtime wired; the `ai-generation` queue (concurrency 8)
existed since task-15 but was unused until now.

**YouVersion client** (`src/providers/youversion.ts`): `getBibleCollection` + `fetchPassage`,
injectable fetch. **Built to the STUB's actual routes** (`GET /data-exchange/v1/bibles`,
`GET /data-exchange/v1/passages?version=&reference=`) — a 3-WAY route discrepancy (design-delta
`/v1/bibles` vs nodejs-api's `/v1/bibles/{id}/passages/{ref}` vs the stub) is flagged in a code
comment as implementation-time-verify. Sends `X-YVP-App-Key` (config `youversionAppKey`,
optional) + `language_ranges[]` (real-API-correct; stub ignores them). Typed 400
`YouVersionUnsupportedVersionError` / 404 `YouVersionPassageNotFoundError` **extend
ProviderHttpError** (status 400/404) so `retryUnlessPermanent` classifies them permanent for
free; 5xx → transient ProviderHttpError. New env `YOUVERSION_BASE_URL` (default
`https://api.youversion.com`) + optional `YOUVERSION_APP_KEY`; `youversionBaseUrl` added to the
ProviderConfig singleton (made required → rippled task-29 `config.test.ts`).

**Translation licensing gate** (`generate-script/translation.ts`, pure): `resolveTranslation
({requested, collection})` — collection present → match abbreviation/id case-insensitively, else
throw `TranslationNotLicensedError`; collection `null` (live API unavailable) → **fall back to
public-domain KJV/BSB** (keep a requested KJV/BSB, else default BSB) with the ONLY literal bible
ids in the codebase (justified by the §9-Q10 fallback clause; lives in `workflows/`, not
`providers/`, so the no-model-ids lint doesn't scan it anyway). The fetchScripturePassage step
does a BEST-EFFORT collection lookup (try/catch → null on any error → fallback); only the passage
fetch drives step retries.

**tokenUsage** — added `callLlmStructuredWithUsage` to task-29's `generate-object.ts`
(returns `{object, usage}`); `callLlmStructured` delegates + discards usage (ZERO task-29
ripple). Persisted verbatim as `AiGeneration.tokenUsage` (AI-SDK v5 usage shape
`{inputTokens?, outputTokens?, totalTokens?}`).

**Stub + e2e.** Added a PROGRAMMABLE `POST /__admin/chat-script` response queue to the ROOT
`tests/stubs/src/openrouter-stub.ts` (each `/api/v1/chat/completions` shifts one scripted
response — non-2xx status → step retry, 2xx body → the `message.content`; empty queue ⇒ the
default `{stub:true}`, so task-29 providers e2e is unaffected; `chatCompletions` counts every
call incl. scripted 503s). Wired `youversion-stub` into the dbos e2e `global-setup.ts` (compose-up
list + a collection readiness probe + an openrouter admin-route staleness probe). e2e
(`generate-script.e2e.ts`, 3 tests) drives the exact §6d sequences: 503-then-200 retry
(`chatCompletions===2`), malformed-then-valid repair (`chatCompletions===2`), crash/replay at the
`persistResult` boundary after a repair (`chatCompletions===2` before AND after resume).

**Final green:** db-lib 280 unit; dbos 228 unit (+36) + typecheck clean + 21 e2e (7 files, incl.
3 new generate-script); root 76 unit (+2 openrouter-stub). No regressions.
