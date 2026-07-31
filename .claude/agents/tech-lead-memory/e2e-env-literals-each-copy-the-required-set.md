---
name: e2e-env-literals-each-copy-the-required-set
description: Every dbos e2e spec hand-builds a COMPLETE loadEnv literal, so promoting any var to required reds every lane at module load — and the unit lane's own complete-env fixtures do NOT protect them, which is exactly how 6c8a89b shipped a broken e2e lane
metadata:
  type: constraint
---

`supagloo-nodejs-dbos`'s `src/config/env.ts` `loadEnv()` takes an INJECTED source, and
thirteen e2e specs use that seam by hand-building a **complete** env literal at module
scope. The required-field set of `envSchema` is therefore duplicated thirteen times.
**Promoting any variable to required breaks all of them at module load**, before a single
test is collected — vitest reports `(0 test)` and `Failed Suites`, not a test failure.

## The instance that proved it (2026-07-30 → 2026-07-31)

dbos `6c8a89b` ("fix(env): require YOUVERSION_APP_KEY at boot") dropped `.optional()` from
`YOUVERSION_APP_KEY`. It was a correct change (see [[dbos-worker-had-no-youversion-key]]).
It shipped with the dbos e2e lane red for a day: **10 of 13 files in `npm run test:e2e`
collected 0 tests, and `test:e2e:render` collected 0** — every one with the identical
`YOUVERSION_APP_KEY: Invalid input: expected string, received undefined`.

**The unit lane did NOT protect the e2e specs, and this is the important part.** `6c8a89b`
*did* go red in the unit lane and *was* fixed there — its own diff adds
`YOUVERSION_APP_KEY: "yvp-app-key-value"` to `src/config/env.test.ts`'s `validEnv()` and to
`src/testing/secrets-fixture.test.ts`'s `loadEnv` call. So "a unit test that builds a
complete env" already existed, already fired, and bought nothing, because the e2e literals
are **separate copies**. The commit touched zero files under `tests/`.

Corollary: **another guard cannot fix this class; only shared state can.** A guard says
"something is stale somewhere"; it cannot make eleven independent copies correct.

## The rule for a spec that does not exercise the variable

Pass a **placeholder literal**, not `process.env.X` — matching the neighbouring
`GITHUB_APP_ID: "123456"` / `S3_ACCESS_KEY: "supagloo"` / `TEST_SECRETS_ENCRYPTION_KEY`
fillers. A spec that reads no scripture must not need the operator's real YouVersion key to
boot, and `tests/e2e/load-root-env.ts`'s own header already argues the point: the actionable
failure belongs to the code that needs the credential, not to a spec with no use for one.
Repo-wide spelling for this variable is `"yvp-app-key-value"` (same literal as
`src/config/env.test.ts`), so it greps as one set. Place it in `envSchema` order.

Only `generate-script.e2e.ts` and `youversion-passage-live.e2e.ts` genuinely call YouVersion;
`workflows/generate-script.ts` is the provider's ONLY caller.

## Do NOT "fix" this with `...process.env`

`cleanup-orphaned-assets.e2e.ts` spreads `...process.env` into its literal, and that is the
only reason it survived `6c8a89b`. It looks like the winning option and it is the worst one:
it splices the developer's whole shell into a *validated* config, so `CLEANUP_DRY_RUN`,
`CLEANUP_MAX_ITEMS_PER_RUN`, `RENDER_MEDIA_CONCURRENCY`, `VIDEO_POLL_*` — all env-tunable —
silently change what the spec does depending on who runs it. It trades a loud boot failure
for a reproducibility hole, and it means the spec never states its own preconditions.

## The structural fix (recommended, NOT yet built)

One shared base in `src/testing/` — the boot-only fillers (`GITHUB_APP_*`,
`SECRETS_ENCRYPTION_KEY`, `YOUVERSION_APP_KEY`, `S3_*`) plus the two Postgres URLs — spread
under each spec's own overrides, so every literal states only the fields it is ABOUT. Add
`expect(() => loadE2eEnv({})).not.toThrow()` as a unit test: a future promotion then reds the
**always-run** unit lane, and the one-file fix repairs all thirteen specs at once. That last
clause is the whole point; it is the property `6c8a89b` lacked.

The one part needing care rather than sed: `S3_ENDPOINT` is `http://minio:9000` (container
name, unreachable from the host, fine because unused) in the git-ops specs but the
host-reachable `S3_PUBLIC` in the media/render specs, where it is load-bearing.

`tests/` is NOT typechecked in this repo (`tsconfig.json` is `rootDir: src` /
`include: ["src/**/*.ts"]`), so nothing catches an env-literal mistake before runtime —
same as the api repo ([[api-e2e-seeds-connections-per-spec]]).

Related: [[dbos-worker-had-no-youversion-key]],
[[optional-does-not-weaken-min1-for-empty-strings]],
[[a-silent-return-is-a-green-test-that-never-ran]].
