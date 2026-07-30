# supagloo

Tools for Creators, Built on Gloo AI & YouVersion Platform.

This repository is the unifying **pseudo-monorepo** for the Supagloo platform. It doesn't contain application code of its own; instead it pulls the individual apps in as Git submodules and provides the overarching documentation and a Docker Compose file to run the entire platform locally.

## What it does

Supagloo turns a scripture passage into a short vertical video. You pick a passage, an LLM
plans a storyboard, per-scene images or video clips and a narration track are generated,
and Remotion renders the result. The composition lives as code in **your own GitHub repo** —
Supagloo scaffolds it, commits to it, and tags releases in it.

## Architecture

Five repositories. This one is the pseudo-monorepo: it holds no application code, only the
submodules, the Compose file and the docs.

| Repo | Role | Wired in as |
| --- | --- | --- |
| [`supagloo-nextjs`](https://github.com/ashtable/supagloo-nextjs) | UI + a thin BFF (`app/api/**`). Holds the httpOnly session cookie and forwards to the API with a bearer token. No business logic, no DB or S3 access. | submodule |
| [`supagloo-nodejs-api`](https://github.com/ashtable/supagloo-nodejs-api) | Fastify. Owns auth/sessions, all CRUD, OAuth exchanges, presigned URLs, and job enqueueing. Stateless. **The only S3 URL signer.** | submodule |
| [`supagloo-nodejs-dbos`](https://github.com/ashtable/supagloo-nodejs-dbos) | DBOS worker. Every long, failure-sensitive or money-spending operation: git ops, AI generation, Remotion renders. | submodule |
| [`supagloo-database-lib`](https://github.com/ashtable/supagloo-database-lib) | Prisma schema + migrations, and the shared Zod contracts. Both backends depend on it. | submodule of the three above |
| [`supagloo-prompts`](https://github.com/ashtable/supagloo-prompts) | Local development prompts. Not deployed. | submodule everywhere |

### The system

```mermaid
flowchart TB
    subgraph browser["Browser"]
        UI["supagloo-nextjs<br/>UI + BFF route handlers"]
    end

    subgraph stack["Compose stack"]
        API["supagloo-nodejs-api<br/>Fastify · stateless"]
        DBOS["supagloo-nodejs-dbos<br/>durable workflows"]
        PG[("Postgres 17<br/>supagloo + supagloo_dbos")]
        S3[("MinIO<br/>S3-compatible")]
    end

    subgraph external["External systems"]
        GH["GitHub App<br/>the composition repo"]
        OR["OpenRouter<br/>text · image · speech · music · video"]
        GLOO["Gloo AI Studio<br/>text · image · faith-aligned"]
        YV["YouVersion<br/>sign-in + Bible text"]
    end

    UI -->|"bearer token"| API
    UI -->|"Bible browse only"| YV
    API -->|"enqueue by workflow id"| PG
    API --> S3
    API --> GH
    API --> YV
    DBOS -->|"polls queues"| PG
    DBOS --> S3
    DBOS --> GH
    DBOS --> OR
    DBOS --> GLOO
    DBOS --> YV
```

Two rules explain most of the shape:

- **The repo is the source of truth for composition.** There are no `Composition`/`Scene`
  tables. Each project repo carries a Zod-validated `supagloo.project.json` manifest plus
  generated Remotion sources. Postgres holds identity, connections, jobs and pointers.
- **Generated media never enters git.** Images, clips, narration, music and renders go to
  S3 under `projects/{id}/assets/{assetId}` and `renders/{jobId}/output.mp4`, referenced
  from the manifest by key. The browser only ever sees short-lived presigned URLs.

### Data model

Twelve Prisma models in the `supagloo` database. DBOS keeps its own state in a separate
`supagloo_dbos` database on the same server.

`User` · `Session` · `GithubConnection` · `OpenRouterConnection` · `GlooConnection` ·
`Project` · `ProjectVersion` · `ProjectJob` · `AiGeneration` · `RenderJob` ·
`GalleryItem` · `GalleryUpvote`

Provider credentials are per user and encrypted at rest (AES-256-GCM); OpenRouter's credit
balance is fetched live and never stored.

### The durable layer

Ten statically-registered workflows across four queues. Registration is static by design —
the API enqueues by name with `workflowID` set to a domain record's id, which is what makes
retries idempotent.

| Queue | Concurrency | Workflows |
| --- | --- | --- |
| `git-ops` | 4 | `scaffoldProject`, `importProject`, `commitVersion`, `publishVersion` |
| `ai-generation` | 8 | `generateScript`, `generateImage`, `generateAudio`, `generateVideo` |
| `render` | 1 | `render` — real Chromium; one at a time on purpose |
| `maintenance` | 1 | `cleanupOrphanedAssets` |

Six generation kinds — `storyboard`, `script`, `image`, `narration`, `music`, `video` —
each constrained to the providers that can actually serve it by a shared compatibility
matrix in `database-lib`, enforced with a **422 at enqueue, before any row is written**.
Today `storyboard`/`script`/`image` accept Gloo or OpenRouter; `narration`/`music`/`video`
are OpenRouter-only, because Gloo has no speech, music or video models.

### Creating a project

```mermaid
sequenceDiagram
    participant U as Browser
    participant N as nextjs BFF
    participant A as api
    participant D as dbos worker
    participant G as GitHub

    U->>N: New project (repo + passage)
    N->>A: POST /v1/projects
    A->>A: create Project + ProjectJob
    A-->>D: enqueue scaffoldProject (git-ops)
    A-->>N: { projectId, jobId }
    loop until terminal
        N->>A: GET /v1/projects/:id/jobs/:jobId
        A-->>N: stages[]
    end
    D->>G: clone → write manifest + Remotion sources → commit → push
    D->>G: open PR → merge → tag v0.0.1 → cut working branch
    U->>N: open /studio/[id]
```

### Generating a scene visual

```mermaid
sequenceDiagram
    participant U as Studio
    participant N as nextjs BFF
    participant A as api
    participant D as dbos worker
    participant P as Provider
    participant S as S3

    U->>N: ↻ Reroll visual
    N->>N: inject { provider, model }
    N->>A: POST /v1/ai/generations
    A->>A: 422 if the kind/provider pair is out of matrix
    A-->>D: enqueue generateImage (workflowID = generationId)
    A-->>N: { generationId }
    D->>P: generate
    P-->>D: bytes
    D->>S: upload projects/{id}/assets/{genId}
    D->>A: AiGeneration → succeeded + resultAssetKey
    loop poll
        N->>A: GET /v1/ai/generations/:id
    end
    N->>A: GET /v1/files/presign-download
    A-->>U: presigned URL → preview updates
    U->>N: Commit → manifest written to the branch
```

Video follows the same shape but is asynchronous end to end: `submitVideoJob` persists the
provider's job id **in the same step** as the submit, so a worker restart resumes polling
instead of paying for a second generation.

### Rendering

`render` is the only single-concurrency queue. It bundles the project's Remotion sources and
renders with real Chromium in a scrubbed-env child process, reporting stage and frame counts
that the studio's overlay polls. Narration and music are materialised **before** bundling,
because Remotion snapshots assets at bundle time.

### External systems

- **GitHub App** — installation tokens minted on demand and never stored; only the
  installation id is persisted. Creating a new repo uses a short-lived *user* token in a
  zero-storage hop.
- **OpenRouter** — text, image, speech, music and video. Model ids are never hardcoded;
  they are resolved from the live catalogues.
- **Gloo AI Studio** — text and image, with a `tradition` parameter for faith-aligned
  responses. Images route through `POST /ai/v2/responses`, not chat-completions.
- **YouVersion** — sign-in, plus the Bible language/translation/book/chapter browse that the
  new-project wizard uses. The browse surface is six nextjs BFF routes calling YouVersion
  directly; passage text for generation is fetched server-side by the worker.

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

```bash
cp .env.example .env   # then fill it in — see below
docker compose up --build
```

Then open [http://localhost:8000](http://localhost:8000).

#### The only `.env` that matters is this repo's

**One file: `/.env` at the root of THIS repo.** The service submodules have `.env` files of
their own, and Compose does not read any of them — there is no `env_file:` directive in
`docker-compose.yml`, no Dockerfile copies a `.env`, and each service's `.dockerignore`
excludes `.env` and `.env.*` outright. Those files are for running a service **directly**
(`npm run dev` in its own checkout, or its own test lane).

That asymmetry is worth internalising, because editing the wrong one is a silent no-op:
changing `supagloo-nodejs-api/.env` and restarting Compose changes nothing at all, and
nothing warns you.

Containers get their configuration from exactly two places, both here:

- literal `environment:` blocks in `docker-compose.yml` (`DATABASE_URL`, `PORT`, the `S3_*`
  set, and a throwaway dev `SECRETS_ENCRYPTION_KEY`) — no action needed;
- `${VAR}` interpolation from the root `.env` — **this is the part you fill in**.

#### Required — `docker compose up` cannot work without these

Six variables have no default. All six are real credentials, all live only in the
untracked root `.env`, and `.env.example` documents each one in place.

| Variable | Used by | Notes |
|---|---|---|
| `GITHUB_APP_ID` | api, dbos | |
| `GITHUB_APP_PRIVATE_KEY` | api, dbos | **Single line with escaped `\n`**, e.g. `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n`. It is normalized to real newlines before signing. A multi-line paste breaks shell-style sourcing and the app JWT. |
| `GITHUB_APP_SLUG` | api | |
| `GITHUB_APP_CLIENT_ID` | api | |
| `GITHUB_APP_CLIENT_SECRET` | api | |
| `YOUVERSION_APP_KEY` | nextjs (as `YV_APP_KEY`) | nextjs **refuses to boot** without it, by design — a terminal failure at `register()` beats a 500 page later. |

Leave one blank and Compose still starts, but the owning service fails fast and says which
variable it wants. That is the intended behaviour, not a bug to work around.

#### NOT in `.env` — the AI provider credentials

OpenRouter keys and Gloo client credentials are **per user**, entered through the app's
onboarding wizard or profile page, verified live and stored encrypted in Postgres. They are
not environment variables and there is nowhere to put them in `.env`. A fresh stack starts
with no provider connected; connect them in the UI.

#### Optional

`RENDER_*` (bundle/install/media timeouts, and `RENDER_NARRATION_MODEL` /
`RENDER_MUSIC_MODEL`) and `CLEANUP_*` (retention window, per-run cap, dry-run) all carry
defaults in `docker-compose.yml`; set them only to override.

`GITHUB_E2E_EXCHANGE_TOKEN` is needed **only** with the `docker-compose.test.yml` overlay,
which the e2e harness applies for itself. A plain `docker compose up` never reads it.

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
npm run cleanup:github-e2e                # review 10 at a time, Enter deletes them
npm run cleanup:github-e2e -- --archive   # the reversible action instead
```

It **deletes**, in reviewed batches. One screen of up to `--batch` repos (default 10) is
printed, then confirmed as a unit: **Enter** accepts, `n` skips the batch, `q` stops and
reports everything it never reached as untouched. It archived-only until the volume made
that meaningless — a measurement found 507 throwaway repos against 385 real ones, and
archived repos still list, still count and still page, which had begun failing the
create-new-repo e2e with a secondary-rate-limit 403.

What did not change is the safety property: the `supagloo-e2e-delete-me-` prefix is
re-checked **immediately before every request**, so a repo failing it is never touched even
inside an accepted batch. That mattered when the action was reversible; it is the only
thing standing between a mistake and permanent loss now. There is intentionally no
`--yes-to-all`, which also means it cannot run in CI: reclamation is a human action.
Deletion needs the PAT's classic `delete_repo` scope; with only `repo` each delete reports
a 403 rather than silently doing nothing.

The prefix itself lives in exactly one authored file,
`tests/support/e2e-github-naming.mjs`; the other three repos import it rather than
re-typing it, and `tests/unit/e2e-prefix-single-source.test.ts` greps all four checkouts
to keep it that way. The App **installation id is discovered at runtime** — set
`SUPAGLOO_E2E_GITHUB_OWNER` only if the App is installed for more than one account.

### Every e2e lane is a real lane

`supagloo-nextjs` used to carry a Docker-free `mock` lane driving a fabricated session
against a fixture storyboard. It was deleted: nothing it asserted could fail for a reason a
user could encounter, which makes it not an end-to-end test — and worse than none, because
it reported green while consuming a browser to do it. What it covered (copy, gating,
routing) is unit-testable, and the jsdom lane runs that in seconds on every push.

| lane | script | needs |
| --- | --- | --- |
| real stack | `npm run test:e2e` (alias `test:e2e:real`) | Compose + the DBOS worker + real GitHub creds |
| heavy render | `npm run test:e2e:render` | the same, and runs for many minutes |

`tests/unit/e2e-lane-coverage.test.ts` asserts the two configs partition
`tests/e2e/*.e2e.ts` exactly once — a spec belonging to no lane would never run and never
report, which is a green-lie generator.

Do not run the `supagloo-nodejs-dbos` e2e lanes and the nextjs render lane at the same
time: the dbos crash/replay specs kill and restart the worker, which the render lane is
relying on mid-scaffold.
