---
name: kjv-bsb-generation-only
description: Constraint (2026-07-17) — the generation pipeline may only source KJV or BSB (public domain); display-only use is unaffected
metadata:
  type: constraint
---

**v1 generation sources scripture text from KJV or BSB only** (public
domain). Applies to `fetchScripturePassage` in `generateScriptWorkflow` and
to any UI translation picker on project creation.

**Why:** Supagloo creates and *redistributes derivative video content*,
which has different licensing implications than read-only verse display —
copyrighted translations (NIV/ESV/NLT/NASB etc.) are off-limits for
generation regardless of what YouVersion's API can return. Turn 15's gallery
mock showing a spread of translations is placeholder art, not a requirement.

Exact YouVersion version/translation ids for KJV/BSB must be resolved via
the Data Exchange API's "Get a Bible collection" endpoint at implementation
time — never hardcoded from assumption.
