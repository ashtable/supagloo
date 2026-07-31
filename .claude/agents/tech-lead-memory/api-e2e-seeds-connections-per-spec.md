---
name: api-e2e-seeds-connections-per-spec
description: The api e2e has TWO legitimate connection-seeding paths — real connect routes when the CIPHERTEXT is under test, direct Prisma rows when only EXISTENCE is — and `tests/` is not typechecked at all, which is how a missing required constructor option shipped invisibly
metadata:
  type: convention
---

Established 2026-07-31 fixing revision R1 of the optional-connections review, in
`supagloo-nodejs-api`.

## `tsconfig.json` does not typecheck `tests/`

`"include": ["src/**/*.ts"]`. So `npm run typecheck` covers **none** of `tests/e2e/`.
That is how `tests/e2e/ai-generations.e2e.ts` shipped constructing `AiGenerationsService`
without the now-REQUIRED `connections` option: it compiled fine because it was never
compiled. Runtime effect was `TypeError: Cannot read properties of undefined (reading
'isConnected')` on every case that reached the gate — **7 failed | 10 passed**, all
`expected 500 to be 201`. Widening the include is structural with unknown blast radius;
deliberately left undone, worth scheduling.

## The per-spec seeding rule

Two paths, and choosing the wrong one is either a doc lie or needless provider egress:

- **Seed through the app's own real connect routes** (`src/testing/seed-connections.ts`,
  `POST /v1/connections/openrouter`, `PUT /v1/connections/gloo`) when the **ciphertext is
  part of what you are proving** — that is `connections.e2e.ts`, and it needs three live
  secrets (see [[api-e2e-real-provider-connection-seeding]]).
- **Insert rows directly with Prisma** when only their **EXISTENCE** matters. The
  `provider_not_connected` 409 gate is pure ROW PRESENCE
  (`ConnectionsService.isConnected` — one `findUnique`, `status` is written and never read
  back), so nothing on that path decrypts anything. `ai-generations.e2e.ts` does this with
  placeholder ciphertexts, adding zero secrets and zero provider egress.

`seed-connections.ts`'s docblock used to claim *"There are no fabricated ciphertexts or
dummy keys anywhere in the api e2e"* — direct inserts falsify it, so the sentence is now
scoped to the connections e2e and states the split. `POST /v1/test/seed` cannot help
either way: `AuthService.seed` upserts Users + Sessions only.

## Connected is the DEFAULT; the absence is the opt-in

`seedUser(tag, { connections?: boolean })` seeds the rows unless told not to. 18 call sites
want a user who can create a generation; exactly one — the 409 case — says
`{ connections: false }` at its own call site, where the reader can see that the missing
rows are the point rather than an oversight. The inverse default would have needed 17 edits
and made the refusal case look like every other one.

## Do NOT stub `ConnectionLookup`

It is a **structural** interface, so `{ isConnected: async () => true }` typechecks — and
makes the gate invisible to the lane and the 409 case untestable. Wire the real
`new ConnectionsService({ prisma })`; that is what makes the seeded rows load-bearing.

## A test can pass for the wrong reason and be indistinguishable from one that passes

`"404s a by-id GET for a foreign owner"` was green throughout the outage: the POST 500'd,
`generationId` was `undefined`, and `/ai/generations/undefined` 404s for **everyone** — an
ownership test that had never once exercised ownership. It now asserts `201` and a truthy
id first, plus a `200` for the owner, so the 404 means "not yours" rather than "not there"
(cf. [[owner-scoped-404-is-ambiguous]]). Any e2e that derives an id from a response and
then asserts a 404 has this shape latent.

Related: [[optional-connections-built]], [[api-v1-scope-has-no-global-auth]],
[[a-silent-return-is-a-green-test-that-never-ran]].
