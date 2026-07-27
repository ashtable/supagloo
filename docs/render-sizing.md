# Render sizing — measured numbers and a Railway recommendation

Plan row 45 (design-delta §9-Q8). Produced by `npm run load:render`
(`scripts/render-load.mjs`), which is the repeatable harness the row asks for. Re-run it
after any change to the render pipeline and update the numbers here; the harness prints a
JSON block for exactly that.

---

## 0. What you are allowed to conclude from this document

Read this section before quoting any number below.

1. **The fixture renders TEN FRAMES at 320×180.** One scene, one second at 10 fps, one
   cached PNG, one silent WAV. It is the fixture the dbos render e2e lane builds, and
   design-delta §11.9:2597–2602 says of it, in as many words, **"do not overclaim it."** A
   representative multi-scene 1080×1920 fixture is **plan row 61 and does not exist yet**.
   Every per-render duration here is therefore a *floor* — it measures the fixed cost of the
   pipeline (clone, install, bundle, browser start, upload) almost entirely, and the
   variable cost of encoding almost not at all.
2. **api and dbos are NOT deployed to Railway** (current-design §6:932–935). Row 46 is the
   deploy row and it has not run. Every Railway number in §4 is an **extrapolation from
   Docker Compose on a developer laptop**, not a measurement of a deployed service. It is
   offered as a starting point for row 46, and row 46 should re-measure.
3. **Nothing here changes `render: { workerConcurrency: 1 }`.** Row 45 *confirms* that
   value; it was already firm (`dbos/src/dbos/registry.ts`, design-delta §9-Q8:1560–1564).

---

## 1. Measurement substrate

| | |
|---|---|
| Host | Apple silicon, macOS 25.5, Docker Desktop |
| Docker VM | 10 CPUs, 7.75 GiB RAM available to containers |
| Container | Compose service `dbos`, image `supagloo-dbos` (568 MB), `shm_size: "1gb"` |
| Memory ceiling | **none** — no `mem_limit`, no `deploy.resources` (D45.5) |
| Worker | `@dbos-inc/dbos-sdk` 4.23.6, queues `git-ops`(4) `ai-generation`(8) `render`(1) `maintenance`(1) |
| Renders | real clone from **github.com**, real `npm ci --ignore-scripts`, real `@remotion/bundler`, real headless Chromium H.264 encode, real MinIO upload |
| Provider spend | **zero** — see §3.3 |

The harness enqueues through `DBOSClient` into the **default `dbos` system schema**, which
is what the containerised worker polls. This is the opposite of every e2e lane in the
project (they use private `dbos_e2e_*` schemas); a lane schema here would be accepted and
never dequeued.

---

## 2. Measured results

### Run A — N = 2, sampled every 5 s

```
renders            : 2 (completed 2, failed 0, unfinished 0)
per-render seconds : 15.0, 7.2
p50 / max seconds  : 15.0 / 15.0
wall-clock span    : 23.4 s
overlap ratio      : 0.954     (<= 1.000 means no two renders overlapped)
max simultaneous   : 1         (PENDING render workflows, ever)
dbos peak RSS      : 944 MiB of 7.75 GiB (11.9%)
dbos mean RSS      : 508 MiB over 5 samples
dbos peak CPU      : 186.5 %
```

### Run B — N = 4, sampled every 2 s (the headline run)

```
renders            : 4 (completed 4, failed 0, unfinished 0)
per-render seconds : 7.3, 7.2, 6.7, 6.6
p50 / max seconds  : 7.2 / 7.3
wall-clock span    : 30.5 s
overlap ratio      : 0.917
max simultaneous   : 1
dbos peak RSS      : 1063 MiB of 7.75 GiB (13.4%)
dbos mean RSS      : 525 MiB over 11 samples
dbos peak CPU      : 252.2 %
```

All six renders produced a real `output.mp4` **and** a real `thumb.jpg` in MinIO, with
`framesDone = framesTotal = 10`. Zero failures, zero timeouts, zero OOM.

### What the numbers say

- **Cold vs warm.** Run A's first render took 15.0 s and every subsequent render in both
  runs took 6.6–7.3 s. The difference is the container's `npm` cache (`/root/.npm`, 235 MB
  after these runs). The steady-state number is ~7 s; the 15 s is what the *first* render
  after a container restart costs.
- **Serialization is real.** `max simultaneous = 1` across both runs, and the overlap ratio
  — Σ(individual durations) ÷ (last finish − first start) — is below 1.0, meaning the
  renders not only did not overlap, there was idle time between them. Run B: 27.8 s of work
  inside a 30.5 s span ⇒ **~0.7 s of queue-dispatch latency per render**. That is DBOS's
  queue poll interval, not a defect.
- **Memory is dominated by fixed costs, not by frames.** 1063 MiB peak for a 320×180
  10-frame encode is Chromium's process tree plus the Remotion bundler, not pixel buffers.
  This is exactly why §4's extrapolation to 1080×1920 is not a simple 36× multiply — and
  also why it is not trustworthy without row 61.
- **CPU peaks at ~2.5 cores** with Remotion's `concurrency` left at its default.

---

## 3. Configuration findings

### 3.1 `shm_size` — shipped, and it is a correctness guard

`docker-compose.yml`'s `dbos` service now sets `shm_size: "1gb"`. Docker's default `/dev/shm`
is 64 MB; Chromium's renderer processes use shared memory and die with a bare,
unattributable crash when it runs out — which surfaces as a failed render with no useful
error. Verified inside the running container: `shm 1.0G`.

No `mem_limit` and no `deploy.resources` were added (D45.5). A memory ceiling on `dbos`
changes the stack that every e2e lane in four repos runs against; a constrained profile
belongs in a `docker-compose.load.yml` override, not in the shipped file.

### 3.2 `RENDER_MEDIA_CONCURRENCY` — shipped UNSET, and you should set it in production

Remotion's `concurrency` defaults to **half the machine's CPU threads**. Each unit is a
Chromium tab holding decoded frames, so it is the single largest memory lever in the
pipeline.

The trap, and the reason this variable exists: **that default reads the host's thread count,
not the container's cgroup quota.** A worker on a 2-vCPU plan scheduled onto a 64-thread
host will happily open far more tabs than it has CPU or memory for. On a constrained
deployment, set it explicitly.

It ships unset because api and dbos are not deployed to Railway, so any default would be a
guess baked into every render on the strength of a measurement not made (S11).

### 3.3 Provider spend is structurally zero, but not for the documented reason

The design says `ensureNarrationAudio` / `ensureMusicAudio` synthesize *only if the manifest
lacks cached asset refs* (design-delta §7:1320–1322), and brief §10 R8 leans on that so N
renders cost time rather than money.

**MEASURED, and it does not hold for narration.** `canonicalizeManifest`
(`dbos/src/remotion/manifest-json.ts`) writes `music.assetKey` but **drops
`narratorVoice.assetKey`** — it copies only `description` and `label`. So no manifest that
has round-tripped through a commit can carry a cached narration ref, and the cached-ref arm
is unreachable for narration today. Every render-lane fixture in the shared dev database
exhibits it.

What actually keeps this free is the *other* arm: `planAudioTrack` cannot synthesize without
a model id, and `RENDER_NARRATION_MODEL` / `RENDER_MUSIC_MODEL` both ship **unset** — an
unset model means the render proceeds without that track rather than paying for one.
Verified against the running container's environment before each run.

The harness therefore gates on the real condition (`assertNoProviderSpend`): a track is safe
if it has a cached ref **or** the worker has no fallback model for it. The serializer gap is
a dbos/db-lib defect, recorded here rather than worked around silently.

### 3.4 Which timeout was tuned — stated plainly, because §9-Q8 is easy to over-claim

There are **three** different deadlines in play and they are routinely confused:

| Deadline | Where | Today |
|---|---|---|
| Workflow timeout | DBOS `timeoutMS` | unused — DBOS has **no per-step timeout**, only a whole-workflow one (`dbos/src/config/env.ts:183-187`) |
| Child-process kill deadline | `RENDER_MEDIA_TIMEOUT_SECONDS` | **3600 s**. This is what §9-Q8's "generous step timeout" has always actually been. |
| Remotion `timeoutInMilliseconds` | `renderMedia` option | Remotion's default is **30 000 ms**, and it is the budget for resolving `delayRender()` calls — a per-asset stall detector, **not** an overall render budget. |

**FINDING, and it needs a decision.** `dbos/src/workflows/render/media-options.ts` (landed
earlier in this same run) now passes `timeoutInMilliseconds = mediaTimeoutMs`, i.e.
3 600 000 ms, on the stated reasoning that a per-frame budget above the kill deadline is
useless. The Remotion semantics make that backwards: raising this option from 30 s to an
hour converts a *fast, attributable* `delayRender()` failure ("asset X never resolved") into
a *silent one-hour hang* ending in a SIGTERM with no attribution — which is precisely the
failure mode the change set out to prevent. A wedged asset is exactly what the 30 s default
exists to catch.

Recommendation: give it its own bounded value — generous relative to a single asset load but
far below the kill deadline. `120 000 ms` is ~17× Remotion's default and ~1/30th of the
child kill deadline, and no render measured here spent more than ~7 s in total. Do not
mirror `RENDER_MEDIA_TIMEOUT_SECONDS` into it.

Nothing else about `renderMedia` was changed: the step stays `{ retriesAllowed: false }`
(deliberate — a half-written encode must not be retried blindly).

---

## 4. Railway sizing recommendation (EXTRAPOLATED — see §0.2)

For the `dbos` worker service, when row 46 deploys it:

| Resource | Recommendation | Basis |
|---|---|---|
| Memory | **≥ 4 GiB** for 1080×1920 output; 2 GiB is the floor for anything | measured 1.06 GiB peak at 320×180 with the default concurrency; frame buffers scale with W×H×concurrency while the Chromium/bundler floor does not |
| vCPU | **2 minimum, 4 recommended** | measured peak 252 % ≈ 2.5 cores at Remotion's default concurrency |
| `RENDER_MEDIA_CONCURRENCY` | **set it explicitly**; start at `2` on a 2-vCPU plan | §3.2 — the default reads the host's thread count, not the cgroup quota |
| `/dev/shm` | **≥ 1 GiB** | §3.1; a 64 MB default kills Chromium unattributably |
| Ephemeral disk | **≥ 3 GiB** | image 568 MB + `node_modules` 768 MB + npm cache 235 MB, plus one clone-and-`npm ci` workspace per in-flight render |
| Queue concurrency | **leave at 1** | unchanged and firm; one render already peaks at 2.5 cores |
| `RENDER_MEDIA_TIMEOUT_SECONDS` | 3600 is fine | it is a kill deadline, not a budget; it costs nothing when unused |
| Scaling | add **worker instances**, never per-worker concurrency | `workerConcurrency: 1` is the design's chosen unit; DBOS distributes queue work across instances |

**What would make these numbers real:** plan row 61's multi-scene 1080×1920 fixture, then
`npm run load:render --count 4` against it, then row 46's deployed service re-measured with
`RENDER_MEDIA_CONCURRENCY` pinned. Until then, treat §4 as a starting point with a known
provenance rather than as a result.

---

## 5. Running the harness

```
npm run load:render                       # N = 2 against the newest usable subject
npm run load:render -- --count 4 --poll-seconds 2
npm run load:render -- --render-job <id>  # pin the subject
npm run load:render -- --dry-run          # resolve + verify, enqueue nothing
```

It requires the Compose stack to be up, and a **render subject** — a project whose repo
really holds a pushed Remotion scaffold and whose version has completed a render before. The
dbos render e2e lane leaves those behind on every run; the harness picks the newest usable
one and prints which. It refuses to run, loudly, if none qualifies.

**What a run leaves behind**, since nothing reclaims it: `N` `RenderJob` rows with ids
`render-load-<runId>-<n>`, their DBOS workflow rows in the default `dbos` schema, and `2N`
small objects in the `supagloo-dev` MinIO bucket. They are all id-prefixed, so
`DELETE FROM "RenderJob" WHERE id LIKE 'render-load-%'` bounds the database half exactly.
No GitHub repos are created — the harness deliberately re-renders an existing subject rather
than provisioning one, so it adds nothing to the ~18–23 throwaway repos a full e2e sweep
leaves for `npm run cleanup:github-e2e`.
