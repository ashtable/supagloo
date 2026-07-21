---
name: openrouter-gloo-connect-ui-wired-nextjs
description: Task 25 wired the REAL OpenRouter (browser-side PKCE) + Gloo (verify-then-store) connect flows into supagloo-nextjs — the popup+poll effect layer, the client callback page, the live-credits/masked-key profile, and the Stagehand-CDP fetch-shim e2e pattern
metadata:
  type: convention
---

Built 2026-07-20 (plan task 25, M4). TDD plan:
`scratch/task-25-openrouter-gloo-connect-ui.md`. Edits ONLY in
`~/code/supagloo-nextjs` (branch v0.0.25). Builds on
[[github-connect-ui-wired-nextjs]] (task 24: `forwardToApi`, poll-based effect
layer, `connectProvider` mock/real branch, `completeGithubConnectViaCallback`) +
[[openrouter-gloo-connections-built]] (task 12 API, unchanged). Realizes
design-delta §5.1/§5.3/§6a/§2.4/§2.5/§9-Q5.

**OpenRouter = browser-side PKCE, resolved by POLLING (mirrors github's popup+poll).**
`connectProvider("openrouter")` in real/seed mode: `beginConnect`(pending) →
generate verifier + S256 challenge (`lib/connections/pkce.ts`, Web Crypto) → stash
the verifier in **localStorage** (shared same-origin so the popup callback tab can
read it) → `window.open` the authorize URL → the MAIN tab polls `GET /api/connections`
until openrouter is connected → flip reducer + fetch LIVE credits. The exchange
NEVER touches the BFF/API (§9-Q5): a **client** callback page
`app/connect/openrouter/callback/page.tsx` (NOT a server route, §5.1) reads
`?code=` + the stashed verifier, does the browser↔OpenRouter token exchange
(`POST ${OR_BASE}/api/v1/auth/keys`), then POSTs ONLY the resulting key to
`POST /api/connect/openrouter`, clears the verifier, closes. `OR_BASE` =
`NEXT_PUBLIC_OPENROUTER_BASE_URL` (default `https://openrouter.ai`), overridable for
e2e. Masked display (§9-Q5) = `sk-or-` + SIX `•` + last4 (`maskOpenRouterKey`).
Credits are LIVE, never stored (§2.4) — `GET /api/connections/openrouter/credits` →
`$X.XX credit remaining` on every profile view.

**Gloo = direct form PUT, verify-then-store, error surfaces in the form.** The form
(`gloo-credentials-form.tsx`) is now REAL controlled inputs (`gloo-client-id` +
`gloo-secret` + reveal) with local validation (`validateGlooCredentials`, both
non-empty) gating submit → `onSave(creds)` → `connectProvider("gloo", {clientId,
clientSecret})` → `PUT /api/connect/gloo`. The API mints a LIVE client-credentials
test token; a 400 `invalid_gloo_credentials` becomes a real `gloo-error` in the form
(NOT local validation, §6a) via a `glooError` channel on the session context (set on
failure → back to not-linked; cleared on edit / new attempt / disconnect). Gloo
connected detail gained the real plaintext `clientId` (secret never exposed).

**`connectProvider` signature is now `(provider, payload?: GlooCredentials)`** —
gloo passes creds; github/openrouter take none. Real branches gate on
`!isMock`; mock mode (and any fallback) stays on the `MOCK_OAUTH_DELAY_MS` timer +
`completeConnect`/`OPENROUTER_DETAIL`/`GLOO_DETAIL` constants — the hard invariant
(pure-UI e2e specs unchanged). Reducer additions (kept pure): `connectOpenRouter`,
`connectGloo`; `ProviderDetails["gloo"]` gained optional `clientId`.

**Bootstrap hydrate is now ONE `GET /api/connections` mapped for all three
providers** (was github-only) via the pure `*SnapshotFromConnections` helpers +
live credits — real/seed only, yields to `pending`, never sets not-linked.
**Wizard auto-advance generalized**: openrouter connected → gloo, gloo connected →
done (was github → openrouter only), so a successful optional connect moves forward.

**New BFF routes (thin `forwardToApi`):** `POST/DELETE /api/connect/openrouter`,
`PUT/DELETE /api/connect/gloo`, `GET /api/connections/openrouter/credits`.
Contracts (`lib/api/contracts.ts`) got the real OpenRouter/Gloo/merged Zod mirrors
(replacing `z.unknown().nullable()`), pinned by `contracts.test.ts`.

**Mock-spec fallout (the Gloo form became real inputs):** `workspace-profile.e2e.ts`
E-W1 dropped the `"gloo_client_id…"` textContent anchor (now a placeholder, invisible
to `bodyText()`); E-W5 types valid creds before `gloo-save` (validation gates
submit). Everything else (11c PKCE-callout copy, wizard skips, bff-session E-B2)
untouched — mock mode never hits the real flows.

**E2E "fake OpenRouter's browser leg" pattern — CRITICAL GOTCHA:** Stagehand v3 is a
**CDP understudy, NOT Playwright** — `stagehand.context` is a `V3Context` with NO
`.route()` (Playwright route interception does NOT exist here; `context.route` throws
"is not a function"). Instead inject a `window.fetch` shim via
`context.addInitScript((key)=>{...}, key)` (`tests/e2e/connect-helpers.ts`
`interceptOpenRouter`): it intercepts any `…/api/v1/auth/keys` in-page → a
deterministic `{key:"sk-or-v1-e2etest-cafe"}` (no network, no CORS — the bare stubs
have none). `addInitScript` applies to pages created AFTER the call, so the throwaway
callback page (`completeOpenRouterConnectViaCallback` → `context.newPage()` →
`/connect/openrouter/callback?code=…`, mirroring github's helper) is covered. Set
`NEXT_PUBLIC_OPENROUTER_BASE_URL=http://localhost:4802` so the authorize popup hits
the stub host (local 404), never the public internet. Profile reached via CLIENT-side
nav (`workspace-profile-pill` → `menu-account-settings` `router.push("/profile")`)
to keep the resolved server session — this DEFEATS task-24's deferred `/profile`
deep-link redirect race (serverUser persists across client nav). React-controlled
inputs are typed via the native-setter + `input`-event trick (`typeInto`), since the
understudy has no Playwright `.fill`.

**Live API for the e2e** extends task 24's launcher: same fresh RSA PEM + github-stub
env, PLUS `OPENROUTER_BASE_URL=http://localhost:4802` +
`GLOO_BASE_URL=http://localhost:4803` (the compose stubs). openrouter-stub credits =
`{total_credits:100, total_usage:12.5}` → `remaining 87.5` → `$87.50 credit remaining`.
gloo-stub accepts any Basic creds EXCEPT the reserved `gloo-invalid` (→401 → API 400)
— that sentinel is how the e2e proves the real verify-failure form error.

Final: 247 unit green (28 files, +44); e2e green — openrouter-gloo-connect(5) +
workspace-profile(9, mock) + onboarding-wizard(7, mock) + bff-session(3) +
github-connect(3). Studio/landing/project-wizards specs untouched + unaffected
(mock/public; my real-mode changes no-op there).

**REVISION 2026-07-21 — disconnect must AWAIT the DELETE (was fire-and-forget).**
`disconnectProvider` used to `void fetch(path,{method:"DELETE"}).catch(()=>{})`
then unconditionally flip the reducer to not-linked — so a non-2xx/network error
falsely showed the account disconnected while the server still held the live
credential (OpenRouter key / Gloo secret; worst case: the user disconnects
*because* they think it's compromised). Fix: NEW pure/injectable
`lib/connections/disconnect.ts` (`DISCONNECT_PATHS`, `requestDisconnect`→`{ok}`
awaited + never-throws so a thrown fetch == non-2xx, `disconnectErrorMessage`).
Real/seed path awaits it; flips to not-linked ONLY on `ok`; on failure stays
connected + sets a per-provider `disconnectErrors: Record<Provider,string|null>`
channel on the session context (`clearDisconnectError`; cleared at the start of
each retry), rendered on the connected card as `disconnect-error-<provider>`
(role="alert"). Applied to all three providers (one shared path). **Mock mode
keeps its instant pure-client flip UNCHANGED** (E-W8 github-disconnect + the
pure-UI specs stay synchronous). e2e E-C5's `waitForStatus(...,"not-linked")` is
now a GENUINE happens-after-DELETE barrier (only reached once the real DELETE
resolved 2xx) — not the old timing coincidence. Failure-path e2e deliberately
SKIPPED (no DELETE-failure sentinel in the real stack, unlike gloo-invalid for
verify — disproportionate for a low-pri fix); the fail branch is unit-covered in
`disconnect.test.ts` (7 tests). No reducer primitive needed — "stay connected on
failure" = simply not calling `disconnect()`. 254 unit green (29 files, +7);
openrouter-gloo-connect(5) + workspace-profile(9) e2e green against the real stack.
