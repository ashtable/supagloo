---
name: optional-connections-built
description: The 2026-07-31 ad-hoc run that made connections OPTIONAL at onboarding and enforced them at the point of use — the wizard's deleted GitHub gate, R3's launcher guardrail, the ONE connection-aware model resolver, and the api's second refusal class
metadata:
  type: context
---

Ad-hoc run (no `docs/plan.md` row), requirements R1–R9 in
`scratch/optional-connections.task.md`, plan in `scratch/optional-connections.md`.
**No db-lib and no dbos change** — verified, both repos stayed clean.

## The shape of it

Connections stopped being an onboarding gate and became a **point-of-use** requirement,
enforced at three layers that each cover what the others cannot:

1. **The launcher** (`workspace-home.tsx`) — R3 refuses project create/import.
2. **The Studio controls** — R5/R7 disable what the user's providers cannot serve.
3. **`POST /v1/ai/generations`** — a new pre-row `409 provider_not_connected`, which is the
   only one that covers a stale tab, a direct POST, and the BFF's own fallback path.

## Seams worth knowing

- **`lib/api/ai-matrix.ts` (new)** — the six-kind db-lib matrix mirror. There used to be a
  four-kind copy in `lib/studio/ai-settings.ts` and *nothing at all* for `storyboard` /
  `script`, which is why the storyboard default was unreachable from any picker.
- **`resolveGenerationTarget(kind, env, connected?)`** — ONE function for R4+R6+R8.
  Precedence: manifest choice → **connection-aware repair** → env override → hard fallback.
  The repair outranks the env override because it is a **veto**: an operator default the
  user cannot run is not a default. `SUPAGLOO_AI_MODEL_<KIND>` binds to the PREFERRED
  provider only — otherwise a repair sends a `gloo-…` id to OpenRouter.
  `SUPAGLOO_AI_MODEL_<KIND>_<PROVIDER>` (new) addresses one slot.
- **Two BFF injection sites, both required.** `app/api/ai/models/route.ts` already had
  `body.providers` in scope (zero new fetches). `app/api/ai/generations/route.ts` needs
  `readProviderConnectivity(token)` (`lib/api/connectivity.ts`) — it is the ONLY path that
  resolves `storyboard`/`script`, and it is called on the FALLBACK path only.
- **`state.modelCatalogue.providers`, not `session.connections`,** is the Studio's
  connection truth (decision D4). It is server-derived and documented as meaning CONNECTED;
  the client reducer conflates "not connected" with "we could not ask" and is contaminated
  by `?seed=authed-returning`. `ai-settings-panel.tsx` no longer reads the session at all —
  nothing under `app/studio/` does.
- **`Modal`'s ✕ only renders inside the titled 56px header.** The wizard has no header bar,
  so R2's dismissal needed **wizard-owned** close chrome (`wizard-dismiss`, 28px, under the
  progress rail). Flipping `dismissible` alone yields a dismissible modal with nothing to
  click. R3's modal instead passes a `title` and gets `modal-close` for free.
- **`wizard-skip` is a duplicated testid** (`setup-wizard.tsx` + `gloo-credentials-form.tsx`),
  so R1's GitHub skip is `wizard-skip-github`. That is what keeps `E-B2`'s and `E-G1`'s
  `countTestId("wizard-skip") === 0` assertions TRUE — their comments were corrected and
  `E-B2` gained a positive `wizard-skip-github` count so the pair means what it says.
- **`canAdvance` was DELETED, not softened.** The wizard's auto-advance effect called it, so
  an always-`true` version would have skipped the GitHub step on mount. `isSkippable` became
  the single source the component consults — before this it was exported, unit-tested and
  imported by **zero** components.
- **R2 must land before R3.** `profile-page.tsx` bounces `firstSignIn` users to `/`, so R3's
  redirect target is unreachable until dismissal marks onboarding complete.
  `/profile#connections` and `#connection-${provider}` are net-new anchors; the page had
  none, and the browser's own fragment scroll fires while the island still renders `null`,
  so `profile-page.tsx` needs its own post-guard `scrollIntoView`.

## Two decisions the user did not specify — say so in any briefing

- **`video` is disabled on the same axis as music/narration (D2).** R7 names image + music +
  narration and omits video, but the matrix makes video openrouter-ONLY. The panel's
  `kindAvailable` was ALREADY greying the video model select in that state, so the button
  alone stayed live: the UI said "you cannot configure this" while offering to spend money.
- **R1 reverses stated design intent.** Turn 11's own subtitle reads *"first-time setup
  (GitHub required · OpenRouter + Gloo optional)"*.

## Fragility to watch in the real e2e lane

`project-wizards-real.e2e.ts` connects **GitHub only** and never connects a model provider,
yet R3 lets it through — because `?seed=authed-returning` pre-marks OpenRouter connected in
the CLIENT and `applyConnectionsBase` never sets not-linked, so the real read cannot undo the
seed. It passes for a reason that is an artefact of the seed. Production is unaffected
(`parseSeedRequest` is flag-gated), and the new `optional-connections.e2e.ts` deliberately
uses `authed-fresh`.

Related: [[a-failed-read-is-not-an-answer-about-the-user-s-data]] (the picker/action split on
`null`), [[session-resolved-vs-signed-out]], [[modal-panel-is-viewport-bounded]],
[[one-rule-one-module-many-boundaries]], [[voice-catalogue-must-be-provider-sourced]] (R9's
`PREFERRED_VOICE_NAME` is a NAME, never an id).
