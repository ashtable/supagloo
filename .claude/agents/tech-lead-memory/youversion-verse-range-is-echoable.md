---
name: youversion-verse-range-is-echoable
description: A verse RANGE can be requested without constructing a USFM — `+`-join the echoed per-verse passageIds and the host answers 200 with a canonical `id` it echoes back; the both-sides hyphen form is a 404, and over-requesting a short chapter succeeds with a FABRICATED reference
metadata:
  type: reference
---

Measured live against `https://api.youversion.com` with the real `YOUVERSION_APP_KEY` on
**2026-07-30**, ASV = bible id `12`, NIV11 = `111`. These probes reopened a decision that
had been closed as residual risk since task 34-E5.

## Passage-endpoint forms

| request (`/v1/bibles/12/passages/<enc>`) | result |
|---|---|
| `PSA.121.1` | 200, `id:"PSA.121.1"`, `reference:"Psalms 121:1"` |
| `PSA.121` (chapter) | 200, `id:"PSA.121"`, `reference:"Psalms 121"` |
| `PSA.121.1-4` | 200, `id:"PSA.121.1-4"` |
| **`PSA.121.1-PSA.121.4`** | **404** — the "both sides" form a naive start-end construction produces |
| **`PSA.121.1+PSA.121.2`** | **200**, `id:"PSA.121.1-2"`, `reference:"Psalms 121:1-2"` |
| `PSA.121.1+…+PSA.121.5` | 200, `id:"PSA.121.1-5"` |
| `PSA.119.1+…+PSA.119.176` (2 353-char URL) | 200, `id:"PSA.119.1-176"` |
| `PSA.121.1+PSA.121.3` (non-contiguous) | 200, `id:"PSA.121.1+PSA.121.3"`, `reference:"Psalms 121:1,3"` |
| a human reference (`Psalm 23`, `Genesis 1:1`, `Psalms 121:1-5`) | **404** `{"message":"Bible passage Psalm23 for version 111 not found"}` |

**The consequence.** `+` is a LIST, and the host NORMALISES a contiguous list into a
canonical range id and hands it back. So a range is expressible with **zero construction**:
join `passageId`s the verses route issued, persist the `id` + `reference` the host echoed.
Every character sent came from the provider and every character stored came from the
provider — the same standing `PSA.121` already had. `contracts.ts`'s *"`passageId` is
ECHOED, never constructed"* is intact; what was actually unverifiable was the hyphen form,
and it is unverifiable because it does not work.

Echoed ids ROUND-TRIP, including the `+` list form (`encodeURIComponent` → `%2B`), which is
what lets dbos re-fetch months later what the wizard persisted.

## `min(5, n)` is not pedantry — over-requesting SUCCEEDS

`PSA.117.1-5` on a **two-verse** chapter → **200**, text identical to the whole chapter,
`reference: "Psalms 117:1-5"`. A hardcoded "first 5 verses" does not 404; it commits a
**fabricated reference** naming verses the translation does not have into the user's git
repo, silently. The count must come from `GET /api/bible/verses`.

## Collection pagination: the default page is 25

`/v1/bibles?language_ranges[]=<x>` with **no `page_size`** returns **25** rows.
`language_ranges[]=*` → 25 of a reported `total_size: 1472` plus a `next_page_token`. Every
single-language grant today is under 25 (English 20, Spanish 8, French 6, Hindi 5,
Portuguese 4), so dbos's unpaginated call was **latent, not live** — it did find NIV11. One
more licensed Bible in any language and `resolveTranslation` would have thrown
`TranslationNotLicensedError` about a translation that IS licensed.

`language_ranges[]=eng` and `=en` return **identical** collections, so
`ScripturePassageRequestSchema.language`'s `"eng"` default is not a defect (a prior analysis
claimed it was).

## Chapter shape

`/books/{USFM}/chapters` rows are `{id:"117", passage_id:"PSA.117", title:"117"}` — the `id`
is the bare number and the **verses route takes the `id`** (`/chapters/117/verses`);
`/chapters/PSA.117/verses` is a 404. Consistent across GEN/PSA/JHN/3JN in ASV and NIV11 —
but match a stored `passageId` against the chapters list's own `passageId`, never derive the
`id` from it. They are two independent provider strings.

Related: [[youversion-bible-read-surface-lives-in-nextjs]],
[[task-34-e5-youversion-real-api]], [[gallery-not-filterable-by-book]],
[[wizard-passage-must-travel-as-usfm]].
