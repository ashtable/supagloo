---
name: matrix-order-is-compatibility-not-preference
description: AI_PROVIDERS_BY_KIND's row order states which providers CAN serve a kind, not which one is preferred — `allowed[0]` disagrees with the real default for `script`; and clamping an unusable preference must happen ONCE before the repair, not at each return
metadata:
  type: decision
---

Decided 2026-07-31 (revision R2 / decision D3 of the optional-connections review) in
`supagloo-nextjs/lib/api/ai-config.ts` `repairProvider`.

## The bug being fixed

`SUPAGLOO_AI_PROVIDER_<KIND>` is an unvalidated operator string widened to
`AiProviderName` by a cast, so at runtime it can name a provider the kind cannot serve
(`…_NARRATION=gloo`) or nothing at all. `repairProvider` returned it unclamped and the
caller then did `DEFAULT_MODEL_BY_KIND_PROVIDER[kind][provider]!` into a slot `U-DT17`
*guarantees* is absent → `model: undefined` on a `GenerationTarget.model: string`.

**Blast radius is the whole Studio, not one kind.** `AiModelCatalogueResponseSchema`
requires `defaults[kind].model: z.string().min(1)`, so the parse fails,
`fetchModelCatalogue` returns `null`, and the entire Studio AI surface sits permanently at
"Checking…" with everything disabled. One env var. No lane was ever red because no `.env`,
`.env.example` or `docker-compose.yml` in the five repos sets `SUPAGLOO_AI_PROVIDER_*`.

## D3 — the clamp target is NOT `allowed[0]`

`providersForKind(kind)` returns the `AI_PROVIDERS_BY_KIND` row, which states
**compatibility**. Its order is stable (a module-level literal) but it is not a preference
ranking, and for exactly one kind the two disagree:

| kind | matrix row | `allowed[0]` | `DEFAULT_GENERATION_PROVIDERS` |
|---|---|---|---|
| storyboard | gloo, openrouter | gloo | gloo ✓ |
| **script** | gloo, openrouter | **gloo** | **openrouter** ✗ |
| image | gloo, openrouter | gloo | gloo ✓ |
| narration/music/video | openrouter | openrouter | openrouter ✓ |

Clamping to `allowed[0]` would make a typo in an env var *migrate `script` to the other
provider* by the matrix literal's LINE ORDER. Clamp to `DEFAULT_GENERATION_PROVIDERS[kind]`
instead — the answer the resolver gives with no override at all — so an unusable override
degrades to "as if unset". (`providersForKind`'s own "in preference order" docstring is
therefore inaccurate for `script`; it is a compatibility row.)

## The clamp goes ONCE, BEFORE the repair

Clamping at each `return preferred` site is a half fix, and `U-DT19` caught it in the
red→green loop: the surviving `allowed.find((p) => connected[p])` path is *also* ordered by
the matrix literal, so `script` + unusable override + BOTH connected still answered `gloo`.
There is nothing to repair when the preference was never viable, so normalise first and let
the untouched R4/R6 repair run on a guaranteed-in-matrix preference:

```ts
const allowed = providersForKind(kind);
const wanted = allowed.includes(preferred) ? preferred : DEFAULT_GENERATION_PROVIDERS[kind];
if (connected == null) return wanted;
if (connected[wanted]) return wanted;
return allowed.find((p) => connected[p]) ?? wanted;
```

**Trade-offs:** the clamp silently ignores a misconfigured provider rather than failing
loudly at boot. Accepted because this resolver runs per request on the hot path, the log
line already names the resolved value, and a boot-time throw would take the app down for a
value that has a coherent fallback. Revisit only if operators start mis-setting it in prod.

## Why a sweep of every kind × every connectivity state did not catch it

`U-DT8` did exactly that sweep and still missed it, for two independent reasons: it passes
`{}` for env (so no override dimension), and it **destructures only `provider`, never
`model`** — the field that was `undefined`. Both were fixed; the new `U-DT18` adds the
override dimension and `U-DT20` is the anti-vacuity control proving an IN-matrix override
is still honoured (without it, ignoring overrides entirely would keep U-DT18/19 green).

## Knock-on: a closed vocabulary cannot carry a secret into a log

`tests/unit/boot-hardening.test.ts`'s redaction case used to smuggle its sentinel into the
PROVIDER log line via `SUPAGLOO_AI_PROVIDER_SCRIPT` and asserted two `[redacted:…]` markers.
The clamp makes the provider slot a closed vocabulary (`gloo`/`openrouter`), so it can no
longer echo operator input at all — and it never will, because `redactSecrets` only masks
values of 8+ chars, so no valid provider name can ever be a needle. The case now rides on
`SUPAGLOO_AI_MODEL_SCRIPT_OPENROUTER` (one marker) plus a structural assertion on the
provider line. Verified still red when `redactSecrets` is neutralised.

Related: [[optional-connections-built]],
[[a-failed-read-is-not-an-answer-about-the-user-s-data]],
[[an-anti-vacuity-control-belongs-after-the-loop]].
