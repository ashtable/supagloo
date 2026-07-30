# supagloo

Tools for Creators, Built on Gloo AI & YouVersion Platform.

This repository is the unifying **pseudo-monorepo** for the Supagloo platform. It doesn't contain application code of its own; instead it pulls the individual apps in as Git submodules and provides the overarching documentation and a Docker Compose file to run the entire platform locally.

## Architecture

Supagloo is composed of three applications, each maintained in its own repository and wired in here as a submodule:

| Submodule | Role | Repository |
| --- | --- | --- |
| [`supagloo-nextjs`](https://github.com/ashtable/supagloo-nextjs) | **UI** — the Next.js web frontend | `ashtable/supagloo-nextjs` |
| [`supagloo-nodejs-api`](https://github.com/ashtable/supagloo-nodejs-api) | **API** — enqueues new DBOS jobs | `ashtable/supagloo-nodejs-api` |
| [`supagloo-nodejs-dbos`](https://github.com/ashtable/supagloo-nodejs-dbos) | **App server** — runs durable functions (e.g. LLM calls) via DBOS | `ashtable/supagloo-nodejs-dbos` |

### How they fit together

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ supagloo-nextjs  │────▶│ supagloo-        │────▶│ supagloo-        │
│ (UI)             │     │ nodejs-api       │     │ nodejs-dbos      │
│                  │     │ (queues jobs)    │     │ (durable funcs,  │
│                  │     │                  │     │  LLM calls)      │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

- The **Next.js** app is the user-facing UI.
- The **Node.js API** accepts requests and queues new DBOS jobs.
- The **Node.js DBOS** app server executes those jobs as durable functions — long-running or failure-sensitive work such as LLM calls.

## Getting started

Clone with submodules:

**Clone with submodules — `--recurse-submodules` is not optional here.** This repo is
almost entirely submodules; a plain `git clone` leaves you with four empty directories
and a Compose file that cannot build.

```bash
git clone --recurse-submodules https://github.com/ashtable/supagloo.git
cd supagloo
```

**`--recurse-submodules` must be recursive, and it is by default** — that matters because
the submodules are themselves nested. `supagloo-nextjs`, `supagloo-nodejs-api` and
`supagloo-nodejs-dbos` each vendor `supagloo-database-lib` and `supagloo-prompts` as
submodules of their own, so a one-level checkout gets you the three services with an empty
`supagloo-database-lib` inside each — and every build fails on a missing
`@supagloo/database-lib`.

If you already cloned without it, or a `git pull` brought in a moved pointer:

```bash
git submodule update --init --recursive
```

Verify you got everything — every line should show a commit SHA, and none should be
prefixed with `-` (uninitialised):

```bash
git submodule status --recursive
```

### Running the platform locally

Copy `.env.example` to `.env` first — several services **fail fast at boot** (deliberately,
never silently) without the credentials it documents.

```bash
cp .env.example .env   # then fill it in
docker compose up --build
```

Then open [http://localhost:8000](http://localhost:8000).

`docker-compose.yml` brings up Postgres (both logical databases), MinIO, the one-shot
`migrate` and `minio-init` jobs, the Fastify `api`, the DBOS worker (`dbos`) and `nextjs`.

**Compose builds the three services from the SUBMODULES**, at exactly the commits this
repo's gitlinks name — never from a sibling checkout elsewhere on your disk. That is the
point: what you run locally is what the pinned configuration actually is, so a green local
stack means something about the committed state rather than about your working tree.

The consequence is worth stating plainly, because it changes the edit loop: **a change in
`~/code/supagloo-nextjs` does not reach a container until it is committed, pushed, and the
gitlink here is bumped.** For fast iteration, run that service directly (`npm run dev` in
its own checkout) and point it at the Compose stack's Postgres/MinIO; use Compose when you
want to exercise the integrated, pinned system.

### Keeping submodules up to date

To move to the pointers this repo currently names — the normal case, e.g. after a pull:

```bash
git submodule update --init --recursive
```

**Do not use `git submodule update --remote`.** It fast-forwards each submodule to its
remote tip, silently overwriting the reviewed gitlinks with whatever happens to be on
`main` right now. Gitlinks here are moved deliberately as part of a release, in dependency
order (`supagloo-database-lib` → the three services → this repo), so an accidental
`--remote` produces a combination nobody has tested and a diff that looks like intentional
work.

## Testing

```bash
npm run test:unit   # pure-logic: parses the compose files + the init scripts. No Docker.
npm run test:e2e    # drives the REAL Compose stack (reuse-or-spawn), then tears it down.
```

There is a third entry point that is deliberately **not** a suite:

```bash
npm run load:render            # plan row 45 — the render queue's load/perf harness
npm run load:render -- --dry-run
npm run load:render -- --cleanup   # opt-in teardown; residue is PERMANENT without it
```

It enqueues N real renders onto the shared `render` queue and reports per-render wall
clock, the **exact** maximum number of renders that were ever executing at once (an interval
sweep over the rows' own timestamps — the utilization ratio it used to publish instead does
not answer that question), and the `dbos` container's memory profile. It gates nothing — a
load run occupies the worker for minutes and must never be able to turn the gating suite
red. It needs the Compose stack up **and** the `supagloo-dbos:latest` image built: it reads
the running worker's queue configuration out of the image rather than out of a checkout,
because the image is the only thing that can answer "what is actually running". Each run
leaves rows and MinIO objects behind permanently unless you pass `--cleanup`; row 42's
janitor cannot reclaim them. Its measured output, and the Railway sizing recommendation
extrapolated from it, live in [`docs/render-sizing.md`](docs/render-sizing.md); its pure
utilities are unit-tested by `tests/unit/render-load-harness.test.ts`.

Before a release, [`docs/release-gate.md`](docs/release-gate.md) records which gitlinks
root's e2e was last proven against. It exists because a green suite says nothing unless you
know which trees produced the images. Now that Compose builds from the submodules by
default the two are normally the same thing, and the gate is a cheap confirmation rather
than a second round of work — but it still has to be re-run whenever a gitlink moves,
because the images are then from code the suite has not executed.
`tests/unit/committed-config-gate.test.ts` enforces that the recorded SHAs match the
gitlinks right now, so a bump without a re-run turns it red.

`docker-compose.test.yml` is a **test-enablement overlay**, applied explicitly with
`-f` (Docker never auto-merges a `.test.yml`). It is not optional and not vestigial: it
carries the `NODE_ENV: development` + `SUPAGLOO_ENABLE_TEST_SEED=1` double-gate that the
api's `POST /v1/test/seed` route requires, plus the api's MinIO wiring. Read its header
before changing it.

### Every provider is REAL in e2e — including GitHub

There are no provider stubs. `tests/stubs/**` and its `github-stub` / `git-server`
services were deleted: every e2e lane in all four repos reaches real
`github.com` / `api.github.com`, exactly as production does. **Unit suites keep their
stubs and mocks — no unit lane makes network egress.**

Two consequences worth knowing before you run a suite:

1. **The git-ops e2e lanes no longer run offline.** This is an accepted, deliberate cost:
   the alternatives (keeping dead stubs around, marking the lane optional, adding a
   "fast mode") all quietly re-admit the class of bug this replaced — a suite that passes
   against a fixture the real host would have rejected.
2. **Each run creates throwaway private repos** named
   `supagloo-e2e-delete-me-<slug>-<runid>` in the account where the GitHub App is
   installed, using `GITHUB_E2E_PAT_TOKEN` from your `.env`. A PAT is needed because the
   App installation grants no `administration` permission, so an installation token can
   neither create nor archive a repository. Roughly 18-23 repos per full sweep.

There is **no in-suite teardown**, by design: you almost always need the repo to debug a
red run, and the target account also holds real repos. Reclaim them yourself:

```bash
npm run cleanup:github-e2e -- --dry-run   # just list the candidates
npm run cleanup:github-e2e                # confirm each repo, then ARCHIVE it
```

The script **archives, never deletes**, asks about **one repo at a time**, and re-checks
the `supagloo-e2e-delete-me-` prefix immediately before it mutates anything — a repo
failing that check is never touched even if you answer "yes". There is intentionally no
`--yes-to-all`, which also means it cannot run in CI: reclamation is a human action.

The prefix itself lives in exactly one authored file,
`tests/support/e2e-github-naming.mjs`; the other three repos import it rather than
re-typing it, and `tests/unit/e2e-prefix-single-source.test.ts` greps all four checkouts
to keep it that way. The App **installation id is discovered at runtime** — set
`SUPAGLOO_E2E_GITHUB_OWNER` only if the App is installed for more than one account.

### The nextjs e2e lanes are split three ways

`supagloo-nextjs` separates its Stagehand specs by what they need, so the cheap lane stays
runnable without Docker:

| lane | script | needs |
| --- | --- | --- |
| mock | `npm run test:e2e` | `next dev` only |
| real stack | `npm run test:e2e:real` | Compose + the DBOS worker + real GitHub creds |
| heavy render | `npm run test:e2e:render` | the same, and runs for many minutes |

Do not run the `supagloo-nodejs-dbos` e2e lanes and the nextjs render lane at the same
time: the dbos crash/replay specs kill and restart the worker, which the render lane is
relying on mid-scaffold.
