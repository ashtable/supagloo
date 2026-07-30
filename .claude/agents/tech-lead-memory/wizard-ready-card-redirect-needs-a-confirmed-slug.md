---
name: wizard-ready-card-redirect-needs-a-confirmed-slug
description: Making the "PROJECT READY." auto-redirect real required fixing the client-guessed slug first — an automatic redirect turns a latent 404 into an unavoidable one; the fix asks `GET /api/projects/:id` instead of widening the create response
metadata:
  type: decision
---

Built 2026-07-30. The wizard's terminal card had carried the caption
`"Redirecting automatically…"` since turn 12 with **no** `setTimeout`, no effect and no
`router.push` outside the button's handler — knowingly-retained copy for a knowingly-unbuilt
behaviour (`nextjs/scratch/turn12-13-project-wizards.md:57-67`).

## Why the redirect was built rather than the copy deleted

Design authority is unanimous and the deciding evidence is a *contrast*: the setup wizard's
structurally identical terminal confirmation ("YOU'RE ALL SET." + `Go to my workspace →`)
carries **no** such caption. The designer put the line on exactly one of two matching
screens, and it is the only auto-advance string in the whole wireframe document. Plus the
section comment is literally `<!-- STEP 3 — READY / REDIRECT -->`, the provisioning log's
final pending row is `○ Opening studio`, and the sibling Import wizard lands straight in the
studio.

Copy is verbatim, U+2026, **no countdown number** (none is drawn anywhere, so none is
invented). `READY_REDIRECT_MS = 2500` — the card has a ✓ roundel, a branch name and a URL
chip the design means to be read.

## The blocker that had to be fixed in the same change

`CreateProjectResponseSchema` is `{projectId, jobId}` — no slug — so BOTH tabs used the
**pre-creation typed value** (`completeCreateRepo` returns `slug: params.repoName`;
existing-empty uses the picked repo's short name). The api assigns the slug with
`nextFreeSlug`, which appends `-2`/`-3` on a same-owner collision, and `/studio/[slug]`
resolves **owner-scoped**. plan row 53 item (3) noted the bug was "masked because
`/studio/[id]` still resolves against a hardcoded mock project list" — that mask went away
with task 27's real hydration.

**A human clicking a button can recover from a 404. An automatic redirect cannot, and it
gets there faster than a person would.** So this is not a separable follow-up.

**The fix: ASK the server.** After the scaffold job succeeds, `fetchProjectSlug(projectId)`
does `GET /api/projects/:id` and reads `ProjectDto.slug` — already on the wire, already
parsed. Zero schema change in db-lib, zero api change, no release chain.

**Rejected:** widening `CreateProjectResponseSchema` (a wire change plus a four-repo release
for a value the client can already read); always redirecting to `/studio/<cuid>` (breaks the
drawn `supagloo.com/studio/test-1` chip and every slug-based spec).

**Belt and braces:** when the confirm read fails, `readyRedirectTarget` falls back to the
**projectId**, which is server-issued too — and `resolveProjectBySlug` now matches a project
by `id` as well as `slug` (slug first and exhaustively, so a slug that looks like another
project's id cannot be shadowed). With neither, the target is `null` and the card just stays
put with its button. It never navigates to a guess.

The same one-line confirmation was applied to the **Import** wizard, which guesses the same
way. It has no caption so it promised nothing — but the wrong destination is wrong either
way.

## Two mechanics worth not rediscovering

- The redirect effect must check `aliveRef.current` **at fire time**, not only in cleanup:
  `next dev`'s StrictMode mounts → effects → cleanups → effects, and the wizard's `aliveRef`
  is set `true` on every effect RUN for exactly this reason.
- The card's `onOpen` and the timer use the **same** target, so a click and the timer can
  never disagree about which project "Open in studio" means.
- **Every e2e acquisition helper had to become redirect-aware.** Five real-lane specs did
  `waitForTestId("open-in-studio")` then clicked; the redirect races that click and the node
  is gone. `leaveReadyCardForStudio` waits for `/studio/` first and clicks only as a
  fallback, and an `onProjectReady` hook fires BEFORE any click so a spec can observe the
  redirect rather than its own click.

Related: [[wizard-passage-must-travel-as-usfm]], [[owner-scoped-404-is-ambiguous]],
[[workspace-project-wizards-wired-nextjs]].
