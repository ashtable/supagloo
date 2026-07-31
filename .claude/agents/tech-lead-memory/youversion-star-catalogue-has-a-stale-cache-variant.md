---
name: youversion-star-catalogue-has-a-stale-cache-variant
description: `GET /v1/bibles?language_ranges[]=*` returns 1472 rows to Node's default fetch and 1479 to the same URL with an explicit Accept-Encoding — a stale upstream cache variant that silently drops languages from the studio picker, and that made an e2e green for the wrong reason
metadata:
  type: constraint
---

Measured 2026-07-31, deterministic across 4 consecutive probes per variant.

Same URL, same app key, same process:

| request | rows | `total_size` | contains `aab` |
|---|---|---|---|
| `fetch(url, {headers:{accept, x-yvp-app-key}})` — undici default | **1472** | 1472 | no |
| the same plus `accept-encoding: gzip, deflate` | **1479** | 1479 | yes |
| `…: gzip` / `identity` / `br` | 1479 | 1479 | yes |

So it is not compression — it is the **presence or absence of the header** selecting an
upstream cache variant, and the one undici's default lands on is **stale**. `curl` (which
always sends an `Accept-Encoding`) sees the fresh one, which is why a hand-check disagrees
with the running code.

**It is undetectable from the response.** `total_size` matches the truncated count and
`next_page_token` is `null`, so `fetchLanguageCatalogue` has nothing to test. There is no
error, no partial-page signal, nothing.

## Two consequences

1. **`lib/youversion/client.ts` ships the 1472 view**, so ~6 languages are missing from the
   studio's language picker for real users. Small, but silent and unbounded — the gap is
   whatever upstream has added since that variant was cached.
2. **It made `E-YV1` green for the wrong reason.** That case asserted
   `expect(tags).not.toContain("aab")` to prove the catalogue means "languages WITH
   bibles". Upstream licensed `aab` a Bible (Arum NT, id 4443) on/before 2026-07-31, so the
   assertion should have gone red — and did not, because the client cannot see it. A test
   passing *because* the product is broken is the worst available failure mode, and the
   only reason it surfaced is that its sibling `E-YV4` (which probes
   `language_ranges[]=aab` directly, a different index that is NOT stale) went red.

## What was done, and what deliberately was not

`E-YV1` no longer names a tag: it holds the ratio (catalogue ≪ `/v1/languages`) plus a
subset check on the **primary subtag** — the bibles index carries `sus-Arab`, `ur-Deva`,
`ur-Latn` and friends that have no `/v1/languages` record at all, which the client's own
docblock documents and a first draft of the assertion ignored.

**No workaround was shipped.** Pinning an explicit `Accept-Encoding` in the client would
be cargo-culting a fix for someone else's cache: it is not the documented behaviour of the
header, it could stop working the moment the variant is evicted, and it would bury the
finding. Open question for the user, not a silent patch.

Related: [[youversion-bible-read-surface-lives-in-nextjs]],
[[a-test-that-claims-a-class-must-drive-the-class]],
[[a-baseline-must-hold-every-other-variable-equal]].
