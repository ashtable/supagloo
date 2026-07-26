---
name: gallery-ui-built
description: Row 41 built the public /gallery + "Your videos" in nextjs — the mount-gated grid, the unrecoverable-error-state bug a real run caught, the nav auth-source correction, and the two seams a Stagehand spec needs
metadata:
  type: context
---

Row 41 (2026-07-26) shipped `/gallery` and `/your-videos` in `supagloo-nextjs`, against
the rows-39/40 API. Five things worth remembering, none of which the plan predicted.

**1. A mount-gated grid must render its own loading state INSIDE the gated container.**
D14 says the grid's testid is the honest post-hydration signal. That is true and it is
also not a data signal: `waitForHydrated("gallery-grid")` returns the instant the
container mounts, which is before its first request resolves. Both `gallery-grid` and
`your-videos-list` therefore render unconditionally after mount, with loading / empty /
error as CHILDREN — so the hydration gate stays stable — and every spec needs a second,
explicit *settle* wait (cards, or an explicit empty/error state). Reading counts straight
after `waitForHydrated` is how the first real run reported 0 cards.

**2. An effect keyed on filter state makes a failed first load PERMANENT.** The page-1
effect keys on `[mounted, sort, q]`. A first fetch that failed (the containerised api was
still binding its port) left `failed = true` and nothing could re-run it: re-clicking the
already-active sort changes no dependency. Every later interaction was a no-op and the
grid stayed empty for the whole run. Fixed with an `attempt` counter in the deps, bumped
by an explicit "Try again" button AND by re-selecting the active sort. **The general
rule: an error state with no way out is a dead end — if a fetch can fail, something the
user can click must be able to re-run it.**

**3. The vote routes answer with the item, and the item has no `rank`.** `rank` is a
property of the popular LISTING, so `POST/DELETE /v1/gallery/:id/upvote` sends null.
Reconciling an optimistic vote by adopting the whole server item therefore blanks the
trophy on a card whose position on screen has not changed. The reconcile merges
`{ ...server, rank: displayed.rank }`.

**4. `nav-auth.tsx` had the same `useYVAuth()` bug as `nav-your-videos.tsx`, and
`/gallery` is what exposed it.** A cookie session (the `?seed=` seam, or any
server-established session) carries NO YouVersion auth state. The bug was invisible while
`NavAuth` only rendered inside `PublicLanding` — which itself only mounts when signed OUT
— but `/gallery` is public and shows the nav to both, so a signed-in visitor saw "Sign in
with YouVersion". All three nav surfaces (`nav-auth`, `nav-your-videos`, `mobile-nav`)
now read `useSession().session.isAuthed`, the app's one answer to "is this visitor signed
in". The mock-lane landing/workspace specs stayed green untouched: their assertions are
all in signed-out contexts, and `textIsVisible` queries `a` as well as `button`.

**5. Two spec seams that are not obvious.**
  - A pill whose text is `▲` + a count reads as `"▲8"`. The count needs its OWN testid,
    or every assertion carries the glyph.
  - `stagehand.context.addCookies` rejects `url` and `path` TOGETHER
    (`CookieValidationError: should have either url or path, not both`). Use
    `domain: "localhost"` + `path: "/"`. Planting a fixture user's raw session token as
    `supagloo_session` is how "Your videos" gets tested at all — the seed helper's viewer
    owns upvotes but no renders, so only a fixture AUTHOR has a library.

Related: [[gallery-e2e-seed-helper]], [[gallery-backend-built]],
[[render-api-and-ui-built]].
