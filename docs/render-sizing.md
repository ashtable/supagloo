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
utilization ratio  : 0.954     (Σdurations ÷ span — NOT an overlap test; see below)
max simultaneous   : 1         (PENDING render workflows in the polled snapshots)
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
utilization ratio  : 0.917
max simultaneous   : 1
dbos peak RSS      : 1063 MiB of 7.75 GiB (13.4%)
dbos mean RSS      : 525 MiB over 11 samples
dbos peak CPU      : 252.2 %
```

All six renders produced a real `output.mp4` **and** a real `thumb.jpg` in MinIO, with
`framesDone = framesTotal = 10`. Zero failures, zero timeouts, zero OOM.

### 2.1 What the ratio does and does not prove — read this before quoting §2

The two runs above were recorded with the line labelled **`overlap ratio`** and annotated
"`<= 1.000` means no two renders overlapped". **That inference is false**, and it was this
document's load-bearing evidence for row 45's "complete *serially* per worker".

`Σ(individual durations) ÷ (last finish − first start)` is a **utilization** figure. `> 1`
does imply overlap; `<= 1` implies *nothing at all*, because idle time anywhere in the span
masks arbitrary overlap elsewhere. Running the shipped summarizer on two renders that
overlap **completely** plus one 50 s later returns **0.0588** — which this document would
have read as "no two renders overlapped" and the runner would have printed as approaching
"strictly serial".

The exact statement is available from the same rows at no extra cost and with no sampling:
a sweep over the rows' start/end events, `maxIntervalOverlap`, which must be **1**. The
harness now computes it, prints it as **`max concurrent`**, and **fails the run** when it is
anything else (`assertRendersRanSerially`). `startedAt` is stamped at pick-up, not at
enqueue (dbos `src/workflows/render/status.ts`), so these are genuine execution intervals
and the sweep is exact rather than approximate.

**What that means for the two runs above, stated honestly.** They predate the exact figure,
so it was never computed for them and is not reported here rather than being reconstructed.
Their serialization evidence is the other two legs, both of which stand on their own:

1. **Structural** — `QUEUE_CONFIG.render.workerConcurrency === 1`, read out of the running
   `supagloo-dbos:latest` image before either run enqueued anything (§0.3, and R45-2 below).
2. **Observational** — `max simultaneous = 1` across every polled snapshot of
   `dbos.workflow_status`. Bounded and honest, but it is a *sample*: a sub-poll-interval
   overlap would not appear in it. That is why "ever" was dropped from this line.

The utilization figures are *consistent* with serial execution and are not, by themselves,
evidence of it. Every future run reports `max concurrent` and gates on it.

### What the numbers say

- **Cold vs warm.** Run A's first render took 15.0 s and every subsequent render in both
  runs took 6.6–7.3 s. The difference is the container's `npm` cache (`/root/.npm`, 235 MB
  after these runs). The steady-state number is ~7 s; the 15 s is what the *first* render
  after a container restart costs.
- **Queue-dispatch latency.** Run B put 27.8 s of work inside a 30.5 s span ⇒ **~0.7 s per
  render** of gap. That is DBOS's queue poll interval, not a defect — and it is the one
  thing the utilization ratio is genuinely good for.
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

### 3.2 `RENDER_MEDIA_CONCURRENCY` — shipped UNSET, and that is the right default

**VERIFIED against the pinned `@remotion/renderer@4.0.490`, because three code comments and
this section previously all had it wrong.**

`dist/get-concurrency.js` — the default is

```js
Math.round(Math.min(8, Math.max(1, maxCpus / 2)))
```

i.e. **half the machine's CPU threads, capped at 8** — not the CPU count, and not an
uncapped half. Each unit is a Chromium tab holding decoded frames, so it is the single
largest memory lever in the pipeline; on a 16-thread host the default opens 8, not 16.

`maxCpus` comes from `dist/get-cpu-count.js`: `min(nproc, os.availableParallelism())`. The
earlier claim here — "that default reads the host's thread count, not the container's cgroup
quota" — is **wrong as stated**. Both of those *do* honour a **cpuset** (`--cpuset-cpus`,
and Railway/Kubernetes CPU pinning). The narrower true statement is that only a **CFS
quota** (`--cpus=1.5`, `cpu.max`) escapes them: a container limited by quota rather than by
cpuset still sees the host's threads and will open tabs for CPU it is not allowed to use.
That is the case where you must set this variable explicitly.

**Setting it too high fails every render, at the last step.** `resolveConcurrency` throws
`Maximum for --concurrency is <n> (number of cores on this system)` for any value above the
CPU count — after the clone, the `npm ci` and the bundle, i.e. after all the expensive work.
dbos now **range-checks `RENDER_MEDIA_CONCURRENCY` at boot** against Remotion's own
`RenderInternals.getMaxConcurrency()`, so a bad value is a boot refusal rather than a wasted
render.

**Why it ships unset** — a better reason than the one first given here. It is not "we have
not measured Railway"; it is that Remotion's own default is *already* bounded (min-8) and
*already* cpuset-aware, which makes it a better default than a number extrapolated from
Compose would be. Set it when a CFS quota is in play, or when memory measurement says so.

### 3.3 Provider spend is structurally zero, by either of two independent arms

The design says `ensureNarrationAudio` / `ensureMusicAudio` synthesize *only if the manifest
lacks cached asset refs* (design-delta §7:1320–1322), and brief §10 R8 leans on that so N
renders cost time rather than money.

**That arm was unreachable for narration when these numbers were measured, and is not any
more.** `canonicalizeManifest` (`dbos/src/remotion/manifest-json.ts`) wrote `music.assetKey`
but **dropped `narratorVoice.assetKey`** — it copied only `description` and `label` — so no
manifest that had round-tripped through a commit could carry a cached narration ref. Step 11
(item 15 / RX-4) added the symmetric branch, extended the golden fixture with a narration ref
and added the round-trip assertion. Every render-lane fixture in the shared dev database
still exhibits the old shape, because they were committed before the fix.

What kept the measured runs free is the *other* arm: `planAudioTrack` cannot synthesize
without a model id, and `RENDER_NARRATION_MODEL` / `RENDER_MUSIC_MODEL` both ship **unset** —
an unset model means the render proceeds without that track rather than paying for one.
Verified against the running container's environment before each run.

The harness gates on the real condition (`assertNoProviderSpend`): a track is safe if it has
a cached ref **or** the worker has no fallback model for it. Checking only the manifest, as
this harness first did, refuses runs that provably cannot spend anything.

> **CAVEAT ON EVERY NUMBER IN §3 — and on §4, which extrapolates from them.** They were all
> measured with **no audio-synthesis stage** at all. Until Step-11 item 15,
> `canonicalizeManifest` erased `narratorVoice.assetKey` on every commit, so a committed
> version could not carry a cached narration ref and the load harness's subjects had none —
> `planAudioTrack` answered `skipped`, not `cached`, for narration. With the ref preserved,
> narration is `cached` and still costs no synthesis; a subject that has **never** been
> narrated will additionally pay a **live TTS** call on its first render, which none of these
> figures include. Re-measuring a narrated subject was explicitly ruled *not required* (D9);
> this caveat is the deliverable in its place.

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
| `RENDER_MEDIA_CONCURRENCY` | leave unset on a **cpuset**-limited plan; **set it explicitly** (start at `2` on 2 vCPU) if the limit is a **CFS quota** | §3.2 — the default is `min(8, cpus/2)` over `min(nproc, availableParallelism())`, which honours a cpuset but not a quota. Above the CPU count it **throws** at the render's last step; dbos range-checks it at boot |
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
npm run load:render -- --cleanup          # OPT-IN teardown at the end; see below
```

`--dry-run` and `--cleanup` are **switches**: a value on either is now rejected rather than
silently read as "off" (`--dry-run=1` used to enqueue N real renders), and a bare
`--render-job` is rejected rather than silently auto-selecting a different subject.

It requires the Compose stack to be up **and the `supagloo-dbos:latest` image to exist** —
the harness reads the running worker's `QUEUE_CONFIG` and workflow names out of that image
before it enqueues anything. It also needs a **render subject**: a project whose repo really
holds a pushed Remotion scaffold and whose version has completed a render before. The dbos
render e2e lane leaves those behind on every run; the harness picks the newest usable one
**per project**, skipping its own previous rows, and prints which. It refuses to run, loudly,
if none qualifies.

### What a run leaves behind — permanent by default

`N` `RenderJob` rows with ids `render-load-<runId>-<n>`, their DBOS workflow rows in the
default `dbos` schema, and `2N` small objects in the `supagloo-dev` MinIO bucket.

**Row 42's nightly janitor will never reclaim any of it**, and that is structural rather
than a backlog: `cleanupOrphanedAssetsWorkflow` selects `status in (failed, canceled)` at
both of its `findMany` sites, and these rows are `completed`. Do not wait for it.

`--cleanup` (**opt-in, default OFF**) does the teardown the harness is uniquely able to do —
it holds every id and every asset key it created. It is not the default because the app
database and the single `supagloo-dev` bucket are **shared** with dev and with fifteen e2e
lanes across four repos; a default-on delete would be a destructive action on someone else's
state. It deletes only rows whose ids *this process* minted (`= ANY($ids)`, never a
`LIKE 'render-load-%'` sweep, so a concurrent run is untouched) and only the asset keys those
rows themselves report. It does **not** delete the DBOS `workflow_status` /
`operation_outputs` rows: removing a worker's checkpoints out from under it is not a
supported operation and there is no SDK call for it. Those stay, bounded by N.

Without `--cleanup`, `DELETE FROM "RenderJob" WHERE id LIKE 'render-load-%'` bounds the
database half exactly. No GitHub repos are created — the harness deliberately re-renders an
existing subject rather than provisioning one, so it adds nothing to the ~18–23 throwaway
repos a full e2e sweep leaves for `npm run cleanup:github-e2e`.
