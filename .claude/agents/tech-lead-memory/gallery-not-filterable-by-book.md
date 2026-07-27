---
name: gallery-not-filterable-by-book
description: The gallery has NO book filter — sorts + free-text q only — because which books exist is a property of the translation and YouVersion is the authority
metadata:
  type: decision
---

The public gallery is **not filterable by scripture book** (Ash, 2026-07-26). Its whole
query surface is `sort` (popular | newest | trending), free-text `q`, and `cursor`. The
`book` query field was REMOVED from `GalleryListQuerySchema` in db-lib on v0.0.32 rather
than shipped as dead wire surface.

**Why:** (1) filtering by book is simply not wanted; (2) more fundamentally, **which books
exist is a property of the TRANSLATION and the YouVersion API is the authority on it** — it
varies per translation — so a facet enumerated from a 66-entry book list hardcoded in our
own repo was the wrong design from the start. No code in this platform may present itself
as authoritative about scripture canon.

**Trade-offs:** losing the facet costs discovery on a large gallery (search must carry it);
re-adding it later means a wire addition (cheap, additive) *plus* a per-translation book
source from YouVersion (not cheap) — deliberately not pre-built.

`GalleryItem.scriptureBook` and `deriveScriptureBook` STAY: the column is non-null and the
deriver is the only thing that populates it. It is now correctly described as an internal
best-effort reference-string normalizer with no UI surface — see
[[scripture-book-reference-shape-rule]]. Everything else about the listing stands: all
three sorts including trending, `q`, and cursor pagination.
