---
name: session-resolved-vs-signed-out
description: In supagloo-nextjs `session.isAuthed === false` means BOTH "anonymous" and "we haven't asked yet" — anything that ACTS on it must read `sessionResolved` and derive at render time, never decide in the click handler
metadata:
  type: constraint
---

`SessionProvider` establishes the session in an effect: `GET /api/me` (or the `?seed=`
mint, or the YouVersion exchange). Until it lands, `session.isAuthed` is `false` — the
same value a genuinely anonymous visitor gets. **The two are indistinguishable from that
field alone**, and the window is exactly when an e2e clicks.

Anything that merely RENDERS may treat them the same: signed-out chrome is the honest
first paint either way. Anything that **acts** on the answer must not. A handler that
branches on `isAuthed` at click time sends a signed-in user down the anonymous path and,
having already decided, leaves them there.

`sessionResolved` (added 2026-07-26, on the same context as `mounted`) is the third
state: true once the probe settles *however it settled*, and immediately in pure-client
`?mock=` mode, which asks nobody. `probeSettled` is set in a `finally` around the whole
async IIFE — every branch in that effect returns early, so a flag only the happy path
sets is a flag that hangs.

**The shape that works** (`gallery-browser.tsx`'s `＋ Share yours`): the control records
an INTENT (`setShareRequested(true)`), and which surface that becomes is DERIVED at
render:

```
const shareOpen = shareRequested && sessionResolved && isAuthed;
const promptFor  = promptReason ?? (shareRequested && sessionResolved && !isAuthed ? "publish" : null);
```

No effect (so no `react-hooks/set-state-in-effect` disable), no dead click, and no flash
of the wrong modal — while unresolved, nothing opens, and one render later the answer
picks a side.

**How this was found, and it was not by reading:** gating `＋ Share yours` on `isAuthed`
alone passed the unit lane and two real-lane runs, then failed a third with
`[data-testid="publish-dialog"] never appeared within 30000ms`. Stagehand clicks the
moment `gallery-grid` hydrates, which is before `/api/me` answers. **A flaky e2e on an
auth-gated control is this bug until proven otherwise.**

⚠️ The upvote pill (`onVote` → `anonVoteOutcome(isAuthed, …)`) still decides at click
time and has the same latent race — pre-existing, deliberately left alone, worth fixing
if it ever flakes.

Related: [[gallery-ui-built]], [[nextjs-unit-lane-component-rendering]].
