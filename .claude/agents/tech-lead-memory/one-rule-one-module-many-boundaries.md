---
name: one-rule-one-module-many-boundaries
description: A per-field validation check will always leave a field out — the gallery audit's second round proved it twice; put the RULE in one module, apply it at each value's own boundary, and hold it with a test that enumerates the real route table.
metadata:
  type: decision
---

Closed 2026-07-26 in `/Users/ash/code/supagloo-nodejs-api` (branch `v0.0.38`), after a
confirming skeptic returned NOT-READY on the previous fix with the verdict that it **moved the
gap instead of closing it**.

## What happened, twice

Round 1 found ten unauthenticated 500s behind bound parameters. The fix gated the pagination
cursor's `k`, `t` and `n` — three per-field checks — and shipped an e2e whose title claimed
"a STRUCTURALLY VALID cursor with a hostile payload is a 400 … never an unauthenticated 500".
All eleven of its payloads hardcoded `i: "zzz"` and varied only `k`/`t`/`n`.

Round 2: the cursor's **fourth** field, `i`, was still an unauthenticated 500 on all three
sorts (`22021`), and so were the `:id` path parameter of both anonymous gallery item routes and
three of the publish body's four strings. Measured by sweeping the whole surface: **49 × 500 out
of 1483 probes.**

Widening the sweep past the gallery found **eight more**, behind a valid session, on
`/v1/projects/:id` (×4), `/v1/projects/:id/jobs/:jobId` and `/v1/renders/:id*` (×3).

## The rule that replaced them

ONE module — `src/postgres-text.ts` — answers "is this string safe to bind as Postgres
`text`?", and it is applied at each value's own boundary so each keeps its own error contract:

| value | boundary | reply |
|---|---|---|
| cursor `i` | `decodeCursor` | 400 `invalid_cursor` |
| `q` | `parseSearchTerm` | 400 `invalid_query` |
| every `:id` in the app | the route's params schema | 400 (Zod) |
| the publish body's strings | the route's body schema | 400 (Zod) |

Three clauses with **three different justifications**, and conflating them would be dishonest
(all measured against real Postgres 17 / Prisma 7.8):

1. **`U+0000` is a hard error** — `22021` via `$queryRaw`, `DriverAdapterError` via the typed
   client. The only value Postgres refuses. This is the actual bug.
2. **The rest of C0 + DEL is POLICY** — they round-trip IDENTICALLY. Refused because none
   carries search or display meaning and one predicate beats a carve-out the next control
   character walks around.
3. **An unpaired surrogate is refused for HONESTY** — the driver silently transcodes it to
   `U+FFFD`, so the api would have validated a string the database never stored. **Not a 500.**

`withPostgresSafeStrings(schema)` **walks the parsed value** instead of naming fields, so a
schema that grows a string is covered with no change at the call site. It refines the db-lib
schema (which this repo may not edit) and **returns a new schema — verified not to mutate the
shared object**, so other consumers are unaffected.

## The exempt set, and why order is load-bearing

Exempt = **exactly** tab (U+0009), LF (U+000A), CR (U+000D), derived once and used to BUILD the
forbidden character class, so the two cannot drift (which is precisely how the old JSDoc came to
name three while the behaviour exempted five).

`String.prototype.trim()` treats **five** C0 characters as whitespace — tab, LF, **VT
(U+000B)**, **FF (U+000C)**, CR. Testing the class *after* trimming therefore deleted the
evidence: measured at the previous commit, `?q=%0B` and `?q=%0C` each answered **200 with a full
24-item page, identical to a blank `q`** — a match-everything listing in answer to a hostile
input. `?q=a%0Bb` was already a 400, because trim cannot reach the middle of a string, which is
exactly why the existing test passed while the bug lived. **Test the rule on the RAW string,
before any trim.**

## Why NOT a format regex, and why NOT a Fastify hook

- A cuid-shaped `:id` regex was rejected: it couples every route to the id GENERATOR
  (`@default(cuid())`) and turns every unknown id into a 400, destroying uniform denial. The
  gate is about what Postgres can CARRY, never what an id looks like — so `no-such-item` is
  still an indistinguishable 404.
- A scope-wide `preValidation` hook was rejected: it would silently gate every body in the api
  (OpenRouter keys, Gloo credentials, YouVersion tokens) far outside the reviewed blast radius,
  and it would be a SECOND mechanism alongside the schema refinement.
- No `:id` LENGTH bound: measured, a 200-char and an 8 000-char segment are both **414** from
  the router/transport, and an accepted long id costs one index probe. `q` needs its bound
  because it drives three unanchored `ILIKE '%…%'` scans per row; an id does not.

## The anti-regression mechanism that actually generalises

`src/routes/path-params-gate.test.ts` builds the app with **every** dependency section wired,
enumerates the **real route table** through `onRoute`, and requires every route whose url
contains `:` to have a params schema that rejects the unsafe class in **every** parameter and
still accepts ordinary ids. A new `/:someId` route with an ungated schema fails on the day it is
written. That is the property both earlier passes lacked — and it is a schema test, so it needs
no database.

## SCOPE — corrected 2026-07-26 (revision W3). Read this before quoting the rule

The module's own JSDoc said "every request-derived string **on the surface** passes through
it at its own boundary". **That is wider than the code, and the doc has been narrowed.**
Measured off the real route table: the api has **FOURTEEN `body` schemas across ten route
files, and exactly ONE is wrapped** — `POST /v1/renders/:id/gallery`. Genuinely ungated
bodies that reach Prisma with a caller's string include `POST /v1/projects` and
`PATCH /v1/projects/:id` (`name` → `project.create` / `project.update`),
`POST /v1/ai/generations` (`input` → a jsonb column), and `/v1/projects/import`,
`/:id/commit`, `/:id/publish`, `/:id/renders`.

They stay ungated **on purpose**, for the same reason the `preValidation` hook was rejected:
this was a gallery task (rows 39/40/41), and gating them changes the error contract of seven
route files nobody in that run reviewed, measured or tested. Same defect class as the
anonymous 500s, one authentication step further in — **their own task, with its own sweep.**

`src/routes/body-gate.test.ts` now holds the inventory to the real route table: the set of
routes declaring a body must equal the documented GATED + UNGATED lists, so a new body route
cannot join silently, and the one gated body is proven behaviourally (it refuses an unsafe
string in every one of its four string fields and still accepts a clean one). It is an
INVENTORY, not a gate, and its header says so. When the bodies get their task, UNGATED
shrinks to `[]` and it becomes the gate its sibling already is.

Also W3: the 17-line gate paragraph had been **copy-pasted into five route files** and each
copy asserted "MEASURED on every route below before this change" — but the measured sweep
lists eight 500s in `projects.ts` / `renders.ts` / `project-jobs.ts` only, so `manifests.ts`
and every `ai-generations.ts` route claimed a measurement nobody performed. Six copies of one
rule is the exact opposite of this memory's title. All five are now a single line pointing at
`../postgres-text` and `./path-params-gate.test.ts`; the long form lives here, once.
(`routes/gallery.ts`'s paragraph is a DIFFERENT one — publish body + the rejected cuid-regex
alternative — and stays.)

Related: [[bound-is-not-safe-postgres-value-gates]] (round 1's four defect classes),
[[a-test-that-claims-a-class-must-drive-the-class]], [[gallery-backend-built]].
