---
name: next-dev-compiles-routes-on-first-request
description: The nextjs real e2e lane runs `next dev`, which compiles each page AND each API route module on its first request — so a spec's first mutation pays a compile inside its own poll budget, and a warm `.next` hides it
metadata:
  type: gotcha
---

The nextjs real-stack lane spawns `next dev` (`tests/e2e/global-setup.ts`), and `next dev`
compiles **per route module, on first request**. `gallery-watch.e2e.ts` already knew half
of this — it warms `/gallery/[id]` in `beforeAll` — but a page warm does **not** compile
`app/api/gallery/[id]/upvote/route.ts`, which is a separate module.

**What that costs.** The first vote pays the compile *inside* `pollAttr`'s 20 s budget. On
a cold `.next` (2026-07-26) `E-GW6` failed with
`aria-pressed="false" never became "true" in 20000ms` while all 18 other cases passed. A
warm cache hides it completely — which is the dangerous part: the spec looked stable for as
long as nobody cleared `.next`, i.e. it was green for a reason unrelated to the product.

**Warm the route modules too, anonymously.** The App Router must load a route module before
it can decide the method is unsupported, so an unauthenticated **GET** compiles it just as
well as a real call — 401 or 405, and it writes nothing:

```ts
for (const path of [`/api/gallery/${id}/upvote`, `/api/gallery/${id}/stream-url`,
                    `/api/renders`, `/api/projects`]) {
  await fetch(`${BASE_URL}${path}`).catch(() => undefined);
}
```

Warming with a real session cookie would cast an actual vote and move the very counts the
spec asserts. Prefer warming over raising the timeout: a bigger budget hides a first-compile
stall *and* a genuinely stuck mutation behind the same number.

**Two related traps found in the same sweep.**
- `rm -rf .next` does not give you a clean cold run — the harness's dev-server readiness
  gate is **60 s**, and a from-scratch compile blows through it, so the lane dies in
  `global-setup` with `` `next dev` did not become ready on :3000 within 60s `` and you
  learn nothing. Clear `.next/cache/webpack` instead.
- A manually started `npm run dev` grabs :3001 if :3000 is momentarily busy, and then
  `global-setup` spawns its own on :3002 while polling :3000 forever. `pkill -f "next dev"`
  before running the lane.

**And "hydration is not data" applies to `/your-videos`, not just the grid**
([[gallery-ui-built]] §1). `waitForHydrated("your-videos-list")` returns while the list
still renders `your-videos-loading` and zero `your-videos-card-*`; scanning for a row action
in that window reports "no row offered Share to gallery", which is a lie about the product.
Wait for *loaded* (`your-videos-loading` gone **and** cards > 0) — never for the affordance
under assertion, which would make the assertion vacuous.

Related: [[new-e2e-spec-joins-the-mock-lane-by-default]], [[gallery-watch-page-built]].
