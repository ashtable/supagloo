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

## RESOLVED 2026-07-31 (nextjs `29ea850`) — the header is now pinned

Re-measured before shipping: still 1472 vs 1479, still a strict superset (the
header-carrying variant adds `ceb ycn aab egm jub sax` and drops nothing), and the
upstream `Age` header tells the whole story — ~35 800 s on the default variant vs ~1 200 s
on the other. **User decision: patch it now.**

`lib/youversion/client.ts` sends `accept-encoding: gzip, deflate` on **that one request**,
via a `getJson` `extraHeaders` argument that has exactly one caller. The measurement, the
date and the deletion condition live at `CATALOGUE_ACCEPT_ENCODING`.

Two tests hold it, and the second is the interesting one:

- `U-YV1b` — the catalogue request carries the header **and the other six do not**. The
  scope claim is deliberate: only this index was measured stale, so widening a
  third-party-cache workaround costs a test edit, not a shrug.
- `E-YV1b` (real lane) — fetches BOTH variants live and asserts the client's catalogue
  covers the **union** of their tags, plus an anti-vacuity floor. A bare row-count floor
  (`>= 1258`) was **rejected**: upstream adding 10 languages to both variants makes
  1252 → 1262, which clears a 1258 floor with the header deleted. The union form is red
  for a removal for exactly as long as the divergence exists, and goes quiet — correctly,
  reporting a delta of 0 — if the variants converge.

**The generalisable bit:** when a workaround exists only because two observable variants of
the same resource disagree, pin it by comparing the variants, not by writing down a number
from one of them. The number rots; the comparison does not.

## What was done at DISCOVERY time, and what deliberately was not

`E-YV1` no longer names a tag: it holds the ratio (catalogue ≪ `/v1/languages`) plus a
subset check on the **primary subtag** — the bibles index carries `sus-Arab`, `ur-Deva`,
`ur-Latn` and friends that have no `/v1/languages` record at all, which the client's own
docblock documents and a first draft of the assertion ignored.

**No workaround was shipped in the discovery pass.** The reasoning was that pinning the
header would be cargo-culting a fix for someone else's cache, and would bury the finding.
That was right about the risk and wrong about the remedy: the fix is not "do not patch",
it is "patch, and make the patch's own premise falsifiable" — which is what `E-YV1b`
above does. Raised as an open question for the user, who chose to patch.

Related: [[youversion-bible-read-surface-lives-in-nextjs]],
[[a-test-that-claims-a-class-must-drive-the-class]],
[[a-baseline-must-hold-every-other-variable-equal]].
