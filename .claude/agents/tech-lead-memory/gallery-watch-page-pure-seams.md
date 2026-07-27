---
name: gallery-watch-page-pure-seams
description: Turn 16a's watch page — the BFF GET that came back, and the four pure-logic modules every later slice builds on (nextjs lib/gallery)
metadata:
  type: decision
---

Turn 16a (`/gallery/:id`, the product's one genuinely shareable public URL) rests on a
BFF proxy plus pure logic in `supagloo-nextjs`, all built before any component existed.

**The GET that came back.** `app/api/gallery/[id]/route.ts` shipped in row 41 with a
comment saying there was DELIBERATELY no `GET` — and naming its own reversal condition,
*"if a detail page is ever designed"*. 16a met it, so the handler is back (session cookie
forwarded, because upstream is `optionalAuth` and the response carries the viewer's own
`viewerHasUpvoted` — that is how one endpoint serves an anonymous visitor and a
personalised page without a second route). **Why:** the original objection was never that
the endpoint was wrong, only that an unused proxy is still an exposed one.

**`fetchGalleryItem` parses the DETAIL schema, not the card one.** The realistic wire
drift is being handed a *card* DTO — a perfectly valid gallery item that simply lacks
`makingOf` and `owner.publicVideoCount`. Accepting it renders `undefined public videos`
on a public page, so the detail schema makes `makingOf` **required-but-nullable**:
`null` = "we have no snapshot" (permanent, first-class — every pre-column item), absent
key = "this is not a detail item", which must be a parse failure.

**Two upvote formatters, one per surface, deliberately.** `formatUpvoteCount` abbreviates
(`2.4k`) for cards; `formatExactUpvoteCount` groups (`2,412`) for the watch page. The
design draws both. The separator is a hard-coded comma, never `toLocaleString()` — an
implicit locale renders `2.412` under de-DE, which an en-US visitor reads as a decimal.

**`scenePosterGradient(index, total)` answers a question the design left open.** The
design draws four gradients for a four-scene item and nothing for any other count. The
obvious `RAMP[i % 4]` wraps a 7-scene item back to the darkest stop halfway through and
reads as a bug; the stated rule instead **stretches** the fixed 4-stop ramp — scene 1
always darkest, last scene always brightest, monotonic in between. **Trade-offs:** at
`total === 4` both implementations are byte-identical, so the 4-scene test cannot tell
them apart — the multi-count test (`U-SP2`) is the only thing that pins the rule, and a
mutation to modulo proves it (2 red assertions, all 4-scene assertions still green).

**`shouldResignStreamUrl` re-signs 15 s BEFORE the 120 s presign dies**, not at expiry:
re-signing at T-0 means the player stalls first and recovers second. Nothing signed yet,
or inputs that cannot answer (NaN clock/TTL), also return true — a needless re-sign costs
one request, a stale URL costs a dead player.

Related: [[gallery-backend-built]], [[bound-is-not-safe-postgres-value-gates]].
