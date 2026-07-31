---
name: a-failed-read-is-not-an-answer-about-the-user-s-data
description: "`null` from a never-throwing, never-retrying fetcher means \"we could not ask\" — branching on it as if it meant \"the answer is no\" deleted a committed narrator voice with no dirty flag and no UI to report it"
metadata:
  type: decision
---

**A read that FAILED is not evidence about the value it was going to validate. Never let it
delete, clear, or disable anything the user chose.**

The shipped regression (nextjs, 2026-07-30, fixed at `6b4d1cf`). `fetchModelCatalogue`
returns `null` on **any** failure and never throws, and the effect that calls it runs
**once** per studio open. So `MODELS_LOADED` with `catalogue: null` means one of exactly
two things — "still in flight" or "the read failed and will never be retried this
session" — and **neither** is "the user's saved voice is invalid". The new clear branch
read it as the latter and wiped `storyboard.voiceId` off a manifest-hydrated state.

**Why it was invisible, which is the part worth remembering.** The case deliberately does
not dirty (a background read is not a user edit), so the studio still said *All changes
committed* over a storyboard that had silently lost the field. And `serializeManifest`
writes `narratorVoice.voiceId` only when it is defined — so the user's next **unrelated**
Commit wrote their own choice back out of their repo. A silent in-memory clear plus a
write-when-defined serializer is a **data-loss pair**: neither half looks dangerous alone.

**The same `null` was overloaded on the request side.** `voicesForModelId` collapses four
states to `null` on purpose (no model resolved yet · model not in the catalogue · model
published nothing · empty catalogue), and only *one* of them justifies dropping the pick.
`regenerateNarration` applied `effectiveVoiceId` unconditionally, so pre-catalogue it
validated the id against a vocabulary it did not have and sent nothing — the BFF injects a
model anyway and dbos then discovers the model's **first** published voice. That is the
originally reported bug, reproduced by the fix for it.

**Both fixes are guarded no-ops, and saying why is what makes them safe.** Post-catalogue,
whenever `voicesForModelId` returns `null` the `voiceId` is *already* `undefined` —
`MODELS_LOADED` and `remapVoiceForSettings` clear under exactly that condition, and
`SET_VOICE_ID` can only write an id the rendered list offered. So "keep the pick when the
vocabulary is unknown" is reachable only in the pre-catalogue / failed-read window.

**Do NOT "fix" this by disabling the control instead.** Gating the Regenerate button on
`modelCatalogue !== null` was prescribed twice during review and is wrong: a failed read
never retries, so the button would grey out for the rest of the session with nothing on
screen explaining why. It also contradicts the rule the Publish gate already states
(`studio-context.tsx`): *a failed read dispatches `null`, which the gate reads as
"undecidable" and leaves the button live. Never a stale answer that could deaden Publish
forever.* Same shape as [[head-commit-sha-ahead-of-main-is-not-an-invariant]] — three-valued,
fails open.

**Checklist when a fetcher can answer `null`:** how many distinct states collapse into it;
does the caller retry; does the branch destroy something the user authored; does anything
on screen report it; and does a serializer turn "absent in memory" into "absent on disk".

Related: [[clear-derived-selection-on-effect-rerun]],
[[voice-catalogue-must-be-provider-sourced]], [[session-resolved-vs-signed-out]].
