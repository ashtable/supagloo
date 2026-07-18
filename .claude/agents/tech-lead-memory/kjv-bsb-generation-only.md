---
name: kjv-bsb-generation-only
description: Updated 2026-07-18 — generation sources any translation YouVersion licenses to our app for the user's chosen language, not just KJV/BSB; KJV/BSB are only the default
metadata:
  type: constraint
---

**Superseded 2026-07-18.** The original constraint ("v1 generation sources
KJV or BSB only") no longer holds. Generation now sources **whatever
translation the user selects**, in any language, as long as YouVersion's
"Get a Bible collection" endpoint (`GET /v1/bibles?language_ranges[]=<lang>`,
**without** `all_available=true`) returns it — i.e. whatever YouVersion has
already licensed to our registered app for that language. See
`docs/design-delta.md` §9-Q10 for the full resolution.

**KJV and BSB remain the pre-selected default** for new projects (public
domain, zero licensing ambiguity, safest quick-start) — but this is now a
UI default, not a hard technical restriction. `fetchScripturePassage` in
`generateScriptWorkflow` and the UI translation picker both apply.

**Accepted risk, not resolved by YouVersion's public docs:** the collection
endpoint distinguishes bibles by `license_id` and only returns bibles
"available to your app," but never documents whether that availability
covers *redistribution in derivative video content* versus read-only
in-app display — Supagloo's use case is the former. We're proceeding on
the assumption that "available to your app" is a usable redistribution
signal. If YouVersion's actual terms distinguish those tiers, this needs a
real conversation with YouVersion and a possible narrowing back toward the
public-domain-only posture this replaces.

Bible ids are never hardcoded, not even for KJV/BSB — always resolved via
the collection endpoint at request time. If the live API is unavailable
for a given request, fall back to KJV/BSB only (public domain) rather than
guessing at another translation's licensing.

**Confirmed against real docs** (`developers.youversion.com/api-usage`,
`/api/bibles`, 2026-07-18): base URL `https://api.youversion.com`,
versioned paths (`/v1/bibles`, `/v1/bibles/{id}/passages/{ref}`), auth via
`X-YVP-App-Key` header (app-level key, no separate OAuth for this surface).
BSB confirmed as bible id `3034`; KJV's id is not published anywhere and
must be resolved by filtering the collection response for
`abbreviation === "KJV"`.
