---
name: gallery-watch-page-built
description: Turn 16a's /gallery/[id] watch page (slices C6/C7) — the nav `variant` vs `active` call, the once-per-attempt re-sign guard, why the vote reconcile must NOT spread, and the four claims no Stagehand run can make
metadata:
  type: decision
---

Turn 16a's watch page, built 2026-07-26 in `supagloo-nextjs` as plan slices C6 (the page)
and C7 (retire `gallery-player-modal.tsx`, turn the card's `▶` into a `<Link>`).

Files: `app/gallery/[id]/page.tsx` (server shell + `generateMetadata`),
`app/_components/gallery/watch-view.tsx` (mount-gated island),
`watch-player.tsx`, `watch-details.tsx`; `landing/nav.tsx` gained `variant`;
`gallery/upvote-pill.tsx` gained `format` + `size`.

**`variant`, not a third `active` value.** `Nav.active` answers *which section is
current*, and the watch page **is** the gallery section — a third value would force
`active="watch"` and `active="gallery"` to be mutually exclusive when both are true, and
a creator profile or a playlist page hits the same collision immediately. `variant`
answers *which chrome does this page wear*, and the two compose.
**Trade-offs:** two render branches in one component instead of one; the alternative was
a second Nav component, which forks the brand lockup.

**The presign re-sign is once per PLAYBACK ATTEMPT, not once per URL.** The stream URL is
a 120 s presign and the watch page is the one surface a viewer sits on for longer. Keying
the "already re-signed" guard on the URL is the obvious bug: after re-signing from URL A
to URL B, an error on B is a *different* URL, so it re-signs again — forever, for a
genuinely missing S3 object. The guard is a boolean re-armed by `loadedmetadata`
(playback recovered) or by the explicit `Try again`. Killed mutation: `if (false)` in
place of the guard → the no-loop test goes red.

**A vote response is NARROWER than the item on screen.** `POST/DELETE
/v1/gallery/:id/upvote` answer with the **card** DTO — no `makingOf`, no
`owner.publicVideoCount`. Reconciling with `{...prev, ...server}` renders
`undefined public videos` and deletes the whole HOW IT WAS MADE section on every vote.
Adopt exactly `upvoteCount` + `viewerHasUpvoted`. This is the same family as the row-41
lesson that a vote response carries no `rank` — see [[gallery-ui-built]].

**What a Stagehand run structurally cannot prove here, and therefore what the unit lane
owns.** Four things, all because of where the data comes from:
1. the SSR/hydration contract (it is about the first HTML byte);
2. **any populated `makingOf`** — the snapshot is written by the api at PUBLISH time and
   `tests/support/gallery-e2e-seed.mjs` inserts rows directly, so **every** e2e fixture
   carries `makingOf: null`. The chips, the scripture block and the scene grid have no
   e2e coverage at all and cannot get any without a publish-driven fixture;
3. **the exact-vs-abbreviated upvote format** — a fixture's count is backed by real
   `GalleryUpvote` rows over 8 seeded users, so no e2e count can exceed 8, and `8`
   renders identically under both rules. `2,412` vs `2.4k` is only observable in a unit
   render;
4. the re-sign, which needs a `<video>` error or two minutes of watching.
Writing an e2e for any of these would produce a test that passes without exercising the
rule — the shape [[tests-that-hold-invariants-vs-shapes]] catalogues.

**Three things the design draws that are deliberately NOT rendered**, each because
rendering them would assert something false: the burned-in caption (the renderer burns it
into the mp4 — a second layer prints it twice), a fixed poster gradient (the item has a
real `thumbnailUrl`), and `openGraph.images` (every image URL in this product is a
short-lived presign, and a share card whose image 403s minutes after posting is worse
than no image). `@maryk` and `🎬 Cosmic visuals` are omitted for the reasons the api
already records.

Related: [[gallery-watch-page-pure-seams]] (the pure layer this consumes),
[[gallery-making-of-snapshot]], [[nextjs-unit-lane-component-rendering]].
