---
name: youversion-sdk-freezes-the-access-token
description: useYVAuth memoizes accessToken with useMemo(…, []) over localStorage, so it is permanently null on the OAuth callback load — the root cause of "log in, everything says Not linked until you reload twice"
metadata:
  type: context
---

## The defect

`node_modules/@youversion/platform-react-hooks/src/useYVAuth.ts`:

```ts
const authTokens = useMemo(() => {
  if (typeof window !== 'undefined') {
    return { accessToken: YouVersionPlatformConfiguration.accessToken };
  }
  return { accessToken: null };
}, []);
```

`useMemo(…, [])` — computed **once on first render, never recomputed** — over
`localStorage.getItem('accessToken')`. Meanwhile `YouVersionAuthProvider` starts
`userInfo = null` on every load and only writes the token inside an async `initAuth`
effect, and `isAuthenticated = !!userInfo`.

⇒ On the **OAuth callback load** the first render memoizes `accessToken = null`
permanently. `handleAuthCallback()` then sets `userInfo`, flipping `isAuthenticated` true —
but the token is still the frozen `null`. Any gate of the shape
`isAuthenticated && accessToken` is **false on the one load that needed it**.

## What it looked like from outside

"After logout→login all three connections read *Not linked* and the project grid is empty;
one Cmd-R fixes connections, a second fixes the grid." Two symptoms, two causes:

1. the exchange never ran ⇒ no cookie ⇒ `serverUser` null ⇒ the connections effect
   early-returns and `GET /api/projects` 401s;
2. `WorkspaceHome`'s grid effect was keyed `[mounted, isMock]` — not on the server session
   — and `fetchProjectCards` returns `[]` on ANY failure, so a 401 rendered as "you have no
   projects" and nothing ever retried.

An earlier commit (`271d1b9`) that reshaped this effect was a **latency** fix, not this. Do
not credit it.

## The fix, and the general rule

`isAuthenticated` is `!!userInfo`, and `userInfo` is only set once `handleAuthCallback()`
has RESOLVED — which is after the token reached storage. So whenever the gate is reachable,
a real token is readable; only the memo is stale. Re-read it **in the effect** from the
SDK's own accessor, `YouVersionPlatformConfiguration.accessToken` (exported from
`@youversion/platform-core` — do not duplicate the `'accessToken'` storage key). Prefer the
memo when it has a value; storage is the fallback, and a signed-OUT visitor must never
exchange a leftover token.

**The general rule this leaves behind:** `sessionResolved` is set in a `finally`, so it goes
true even on a load where the exchange never ran, and `session.isAuthed` is true from
YouVersion auth alone (resolveSession branch 3) before any cookie exists. **Neither is a
safe gate for a fetch to an owner-scoped endpoint.** `SessionContextValue.serverUserId` is —
it is the only value that changes when the cookie appears, so it is the only one that will
make a pre-cookie fetch retry. Keying on the ID rather than a boolean also makes a user
switch refetch instead of showing one account another's data.

`signOut()` must reset `connections`/`connectionsSeeded` too: they are derived from an
identity and must not outlive one.

Related: [[session-resolved-vs-signed-out]], [[youversion-signin-live-contract-facts]].
