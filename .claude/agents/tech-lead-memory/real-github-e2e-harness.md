---
name: real-github-e2e-harness
description: Task 62's real-GitHub e2e harness — the ONE prefix file + ONE network harness in root, runtime installation discovery with five fail-fast throws, per-run private auto_init fixture repos, NO in-suite teardown, and the interactive archive-only cleanup script. Read this before writing any e2e that touches GitHub.
metadata:
  type: convention
---

Built 2026-07-25 (plan task 62, design-delta §11). **This replaces
[[provider-stub-harness]] entirely** — `tests/stubs/**` is deleted, there is no
`github-stub` and no local git server, and every e2e lane in root/api/dbos/nextjs
reaches **real github.com / api.github.com**. Unit lanes keep every mock: no real
egress enters a unit suite, ever.

## The two shared modules live in ROOT, and only there

Zero-dependency plain ESM, no build step — that is what makes them work from a
TypeScript spec, a `.mjs` script and three sibling repos at once.

- **`<root>/tests/support/e2e-github-naming.mjs`** — THE prefix
  (`supagloo-e2e-delete-me-`), `buildE2eRepoName`, `isE2eRepoName` (the hard
  gate), and `E2E_RUN_ID` (one per process).
- **`<root>/tests/support/e2e-github-api.mjs`** — THE network harness:
  `discoverInstallation`, `createFixtureRepo`, `waitForRepoReady`,
  `waitForInstallationVisibility`, `createRef`, `putContents`, the assertion
  readers (`listPulls`/`listTagRefs`/`listBranches`/`countCommitsOnBranch`),
  `listOwnerRepos`, `archiveRepo`, and `githubFetch` (which owns `Link: rel=next`
  walking and `Retry-After` / `x-ratelimit-reset` backoff).

api / dbos / nextjs **never re-type the prefix literal**. Each has a thin adapter
(`src/testing/github-e2e.ts` in api and dbos, `tests/e2e/github-e2e.ts` in
nextjs) that resolves the root checkout through the established seam —
`process.env.SUPAGLOO_ROOT_DIR ?? resolve(<repoRoot>, "..", "supagloo")` — and
**dynamic-imports** the two modules by path. Root's
`tests/unit/e2e-prefix-single-source.test.ts` greps the tracked files of all four
checkouts and fails if the literal appears in a second code file; it reports
"checkout not present / submodule not initialised" distinctly from "the literal
drifted".

**The prefix is a constant, never an env var.** The install target is a PERSONAL
account that also holds the project's real repos, and the cleanup script archives
what the prefix matches — a mistyped `SUPAGLOO_E2E_REPO_PREFIX=supagloo-` would
make the gate match `supagloo-nextjs`. The gate must be reviewed code.

## Discovery: nothing about the account is hardcoded

`discoverInstallation()` signs a real App JWT → `GET /app/installations` → matches
`account.login` case-insensitively. Owner: `SUPAGLOO_E2E_GITHUB_OWNER` when set;
else exactly one installation ⇒ adopt it; else throw. Memoised per process.
So `148906100`, `ashtable`, `42` and `acme` appear in **no** file.

It takes an optional `signJwt` callback and **api + dbos pass db-lib's own
`signAppJwt`**, so the harness exercises the PRODUCT signer — a broken signer
fails loudly instead of being masked by a second implementation. Root and nextjs
have no db-lib and use `signAppJwtLocal`, fenced by a unit test asserting the
escaped-`\n` and real-newline PEM forms produce a **byte-identical signature**
(see [[github-app-pem-normalization]]).

**Five fail-fast throws, each naming its remediation** — and every one THROWS,
never `console.warn` + skip (vitest's default reporter collapses a skipped file's
console output, so a "loud skip" is a green lie — plan row 56 item 2):
1. a missing/blank `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_PRIVATE_KEY`
   / `GITHUB_E2E_PAT_TOKEN` → names the var **and** root's `.env` + `.env.example`
2. `401` from `/app/installations` → "does `GITHUB_APP_ID` match this PEM?"
3. zero installations → names `https://github.com/apps/supagloo/installations/new`
4. installations exist but none matches the owner → lists the logins found
5. more than one and no `SUPAGLOO_E2E_GITHUB_OWNER` → names the var + the logins

This is the whole of plan row 62 item (d): the dbos worker was ALWAYS real
(nothing in Compose ever pointed it at the stub), so it had been 404ing on the
fabricated installation `42` all along. It was never a stub-routing bug.

## Fixture repos: PAT creates, installation token does everything else

The installation grants `contents:write` + `pull_requests:write` +
`metadata:read` and **no `administration`** (live-verified), so:

| operation | credential |
|---|---|
| `GET /app/installations` | App JWT |
| `POST /user/repos` (create) | **PAT** |
| `PATCH /repos/:o/:r` (archive) | **PAT**, cleanup script only |
| branch + file seeding | **installation token** |
| everything under test | **installation token minted by product code** |
| assertion **reads** | **installation token** — never the PAT |

Reading with the PAT would be a stronger credential than production ever holds
and could green-light a permission the product lacks. A read that succeeds is
itself a scoping proof.

Create body: `{ name: buildE2eRepoName(slug, E2E_RUN_ID), private: true,
auto_init: true, description: "<run id> · <spec> · <ISO> · safe to archive" }`.

Three things are load-bearing, not cosmetic:

- **`auto_init: true`** — `scaffoldProjectWorkflow` opens its base PR with
  `base: "main"`, and a commit-less repo has no `main`, so real GitHub 422s.
  "Simplifying" this to `false` breaks scaffold, commit, publish and the render
  lane at once. (The product's own create-new path has this bug for real — plan
  row 63.)
- **Per-run names** — the scaffold's v0.0.0 commit is byte-deterministic by
  design, so a REUSED repo rejects a second run. Any "cache the fixture repo"
  optimisation silently reintroduces that rejection.
- **Two ordered gates before ANY enqueue**: `waitForRepoReady` (≤20 s — a
  just-created repo can 404 briefly) then `waitForInstallationVisibility` (≤60 s).
  `ensureRepoReachable` classifies absence as **PERMANENT**, so a missing gate
  produces non-retryable scaffold failures, not a retry.

A repo-name 422 is **FATAL, never retried**: with per-run ids a collision means a
bug, and a retry loop would mask it.

## Fixture repos are NEVER auto-removed. Reclamation is a human action.

**No in-suite teardown, ever — not even on success.** Reasons, in order: the user
mandated per-repo interactive confirmation; a red run's repo is usually the only
way to debug it; and automated mutation in an account holding real repos is
unacceptable. There is deliberately **no** archive/delete helper in any adapter.

The only lifecycle-ending path is `npm run cleanup:github-e2e`
(`<root>/scripts/cleanup-e2e-repos.mjs`):
- pages `GET /user/repos?affiliation=owner`, filters through `isE2eRepoName`
  **imported** from the naming module (never a re-typed literal)
- prints per candidate: `owner/name`, visibility, `created_at`, `pushed_at`, the
  stamped description, `archived`; already-archived rows are listed and skipped
- **prompts per repo**, and on "yes" **re-checks `isE2eRepoName` immediately
  before acting** — the prefix is a code invariant AT THE MUTATION SITE, not a
  filtering side effect, so a mistyped `y` on a mis-listed row is structurally
  incapable of touching a real repo
- **`PATCH { archived: true }` — NEVER `DELETE`.** Archiving is reversible.
- `--dry-run` and `--env-file` exist; **`--yes-to-all` deliberately does not** —
  no non-interactive fast path may defeat the review step. Which means it cannot
  run in CI, so reclamation depends on a human. Accepted cost: plan row 67.

Cost of a full sweep: ~15-20 private repos. There are ~149 accumulated today.
**Never archive or delete a repo on the user's behalf without their per-repo
confirmation.**

## Secrets

`GITHUB_E2E_PAT_TOKEN` (classic PAT) and optional `SUPAGLOO_E2E_GITHUB_OWNER`,
documented **by name only** in `.env.example`. The PAT is **host-side
harness-only and never enters any container** — dbos's `makeRealHostEnvOverrides`
deliberately omits it and the render child-env allowlist keeps it out of render
children by construction. (Plan row 66 would require putting it *into* the api
container; weigh that before doing it.)

Root's `.env` is the single credential source for every lane. Because vitest runs
`globalSetup` in the main process and specs in **workers**, each real lane has a
`setupFiles` entry loading root's `.env` into the worker. The nextjs **mock** lane
deliberately does not.

**Credential redaction on the git exec path — a trap worth remembering.**
`execFileSync` synthesises its rejection message from **argv**
(`Command failed: git clone <url>`), so passing an
`https://x-access-token:<token>@github.com/...` remote as an argv element puts a
live installation token into a message vitest prints verbatim on failure.
`stdio: "pipe"` does **not** help — that string never came from the child's
streams. Every fixture `git` call therefore goes through dbos's
`gitFixtureExec` (`src/testing/github-e2e.ts`), which reuses the product's own
`redactUrlCredentials()` and scrubs message + stdout + stderr. Pinned by a unit
test that runs a real failing `git` with the transport denied (zero egress) and
asserts a token-shaped sentinel is absent. Residual, known: the token is still in
the child's argv while it runs and in a clone's `.git/config` under the temp dir.

## Exactly-once proofs (what replaced `/__stub/calls`)

Two independent axes, never one counter — see [[e2e-test-infra-conventions]] for
the full rule. The reading rule bears repeating because it is a bug class:
**assertion reads always pass `state: "all"`.** A merged PR is `closed`.

## Isolation and rate limits

One `E2E_RUN_ID` per process. Repo **creation** is funnelled through a
module-level mutex with ~1 s spacing: repo create/archive fall under GitHub's
*secondary*/abuse limits, which are account-scoped and far tighter than the
verified 12500/hr core limit. `403`/`429` honour `Retry-After` /
`x-ratelimit-reset` with capped backoff **inside the harness**, and the header
value is surfaced verbatim in error text — never asserted on. Product-side retry
is plan row 64, deliberately not done.

**Never run the dbos e2e lanes and the nextjs render lane concurrently**: the
dbos crash/replay specs kill and restart the worker while the render lane may be
mid-scaffold.

## Gotchas that cost real time

- The containerised api+dbos build from the **submodule** pointers unless the
  gitignored `docker-compose.override.yml` redirects them. In-flight api/dbos
  code in a browser lane therefore REQUIRES that override.
- `docker-compose.test.yml` survives as the **test-enablement** overlay. Its
  `NODE_ENV: development` + `SUPAGLOO_ENABLE_TEST_SEED: "1"` double-gate
  `POST /v1/test/seed`, which every nextjs real-stack spec gets its session
  through. Deleting either line re-breaks row 62 item (a). It is not vestigial.
- A wizard spec that selects `[data-testid^="repo-row-"]` grabs the FIRST row,
  which against an all-repos installation is one of the user's REAL repos.
  Always type the fixture repo's name into `repo-search` and click
  `repo-row-<name>` explicitly — and assert the row has no `data-disabled`
  first, because a disabled row's click is a silent no-op that surfaces as an
  inexplicable timeout.
- Real clone/push/PR/merge pushed the wizard's `project-ready-card` wait to
  **240 s** (from 120 s).

Plan doc: `scratch/task-62-real-github-and-render-e2e.md` (gitignored — the
durable record is **design-delta §11**). Related:
[[github-app-installation-tokens]], [[github-app-pem-normalization]],
[[scaffold-project-workflow-built]], [[render-workflow-gotchas]].
