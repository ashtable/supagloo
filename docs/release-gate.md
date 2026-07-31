# The committed-configuration gate

**One question: has anybody run this repo's e2e suite against the trees
`docker-compose.yml` actually names, at the gitlinks it names them at *right now*?**

`tests/unit/committed-config-gate.test.ts` enforces every claim below.

---

## 1. Why the gate exists (RX-9)

`docker-compose.yml` builds four services from root's **submodules**, and as of
2026-07-29 that is the only way it is built:

```
migrate  ->  ./supagloo-nodejs-api
api      ->  ./supagloo-nodejs-api
dbos     ->  ./supagloo-nodejs-dbos
nextjs   ->  ./supagloo-nextjs
```

**The sibling-checkout override is retired.** A gitignored `docker-compose.override.yml`
used to redirect all four contexts to `~/code/*` so that `docker compose up --build`
exercised in-flight code before the gitlinks moved. That convenience was also the entire
reason this gate had to exist: it meant every green e2e run in this repo's history was
obtained against trees the committed configuration did not name, and the two demonstrably
diverged — Step 8's M13 found the dbos submodule missing a source file the sibling had, and
a nextjs image built from an un-bumped submodule failed E-BH5, E-BH6 and E-BH8.

The support code still tolerates the file's presence (`tests/e2e/global-setup.ts` and
`boot-hardening.e2e.ts` add it conditionally, and it stays in `.gitignore` so a stray copy
can never be committed) — but it is no longer part of the workflow, and re-creating it
re-opens exactly the hole described above. To exercise in-flight service code, bump the
gitlink; to iterate fast, run that service outside Compose.

Retiring it is the strongest available form of the rule in
`feedback-never-fake-submodule-resolution`: that memory forbids trusting a consumer's green
suite when the dependency it resolved was not the released, pinned one. The override was
the same failure at one level up — root's suite resolving three services from somewhere
other than its own gitlinks — and the only durable fix for "don't fake submodule
resolution" is to remove the mechanism that faked it.

**What the gate still guards, and it is not nothing.** Building from the submodules makes
the images *nameable*, not *proven*. The moment a gitlink moves, `docker compose up --build`
produces images from code this suite has never executed, and `boot-hardening.e2e.ts` is
precisely the suite that catches a service which boots wrong. So the marker below records
the three SHAs the last green run was obtained at, and the unit guard fails if they are not
the gitlinks as they stand — a bump without a re-run is red, which is the whole point.

---

## 2. The procedure

Run it after db-lib's release and after every consumer gitlink + `ARG DATABASE_LIB_REF`
sync, and after root's own three gitlinks are bumped. In order:

1. **Bump root's three code gitlinks** to the released commits
   (`supagloo-nextjs`, `supagloo-nodejs-api`, `supagloo-nodejs-dbos`).
2. **Confirm no `docker-compose.override.yml` exists.** It is retired (§1); if one has
   reappeared, delete it. `docker compose config | grep context` must show all four
   contexts under `./supagloo-*`. This step used to be "move it aside" and is kept as a
   check rather than dropped, because the file is gitignored — nothing in review would
   catch a local copy quietly redirecting the build.
3. **Rebuild all four services from the committed contexts**, cold:
   `docker compose build --no-cache migrate api dbos nextjs`. `--no-cache` is not
   superstition — a cached layer keyed on an identical `package.json` can outlive the
   gitlink move that was supposed to change what is in the image.
4. **Bring the stack up** and let `migrate` complete: `docker compose up -d`.
5. **Run root's full e2e**: `npm run test:e2e`. Verify all nine `boot-hardening` cases
   actually executed (`--reporter=verbose`, real per-case timings — a skipped case reads as
   a pass in the summary line). Two are load-bearing here, one per gitlink: **E-BH8** fails
   if the **nextjs** gitlink predates a boot-affecting change, and **E-BH9** (added
   2026-07-30) fails if the **dbos** gitlink predates its `YOUVERSION_APP_KEY` boot gate.
   E-BH9 also has to be read carefully rather than counted: dbos is a long-running worker,
   so on a stale image it does not exit at all and its `timedOut`/`status` assertions — not
   a plain non-zero exit — are what catch that.
6. **Record the result in §3.**

Anything less means the shipped configuration is untested.

---

## 3. The record

The line below is machine-read. It is either `not-yet`, or the three gitlink shas the run
was verified at — and if it names shas, they must equal root's gitlinks **right now**. Bump
a submodule pointer without re-running §2 and the gate goes red, which is the entire point.

```
COMMITTED-CONFIG VERIFIED AT: a89a09d72417da7eeeaad235679bc237cee559f1 4190c1e1825f2c53064cc78a0b2e5ab30145b110 5986d3f57c52afb9e152291bba92981d83db7b64
```

**2026-07-30 — nextjs `2596e64` → `1446b09` (nav source link + a stale gloo e2e wait).**
Ran §2 in full: no override present, `docker compose build --no-cache migrate api dbos
nextjs` from the submodules, `up -d` with `migrate` reporting "No pending migrations to
apply.", then `npm run test:e2e --reporter=verbose` — **5 files / 20 tests green**, lane
wall 7.34 s. All **nine** boot-hardening cases confirmed executed by name, not counted:
E-BH1 780 ms · E-BH2 618 ms · E-BH3 622 ms · E-BH4 590 ms · **E-BH9 717 ms** · E-BH5 784 ms
· E-BH6 670 ms · **E-BH8 1112 ms** · E-BH7 78 ms. The nextjs gitlink moved and E-BH8 is the
gitlink-sensitive case, so the cold rebuild was load-bearing rather than ceremonial.

To record a verified run, replace `not-yet` with the three shas, space-separated, e.g.
`COMMITTED-CONFIG VERIFIED AT: <nextjs-sha> <api-sha> <dbos-sha>`, taken from
`git ls-tree HEAD supagloo-nextjs supagloo-nodejs-api supagloo-nodejs-dbos`.

**State at the time of writing (Step 11):** `not-yet`. Root's gitlinks were
`supagloo-nextjs 41d2416`, `supagloo-nodejs-api 4a6e4ec`, `supagloo-nodejs-dbos da194db`,
all of which predated this run's work in those repos. Every e2e figure anyone quoted from
root at that moment had been measured against the sibling checkouts.

**Verified 2026-07-27 (Step 13), rows 42/43/44/45/48/49/50.** The override was moved aside,
`docker compose build --no-cache migrate api dbos nextjs` rebuilt all four images from the
committed submodule contexts, `docker compose up -d` completed with `migrate` clean, and root's
full e2e ran green: **5 files / 19 tests**, including all 8 `boot-hardening` cases individually
confirmed to execute (E-BH1..E-BH8, real per-case timings 89ms–1097ms — not skipped).
**E-BH8 passed**, so the committed nextjs image serves the container's runtime `YV_APP_KEY` with
no build-time placeholder in the response; that is the case which fails if the nextjs gitlink
predates work-order item 8. The `dbos` container reported the `maintenance` queue at
`worker_concurrency=1`, confirming the committed context carries row 42's registry entry rather
than a stale image.

**Reset to `not-yet` 2026-07-27.** Two later releases bumped all three gitlinks —
first to `7224028`/`b281edb`/`8e39df8` (the compose `SUPAGLOO_API_URL` fix, the JWKS
sign-in verifier and the public-origin BFF redirects), then to
`25bc130`/`81a8f7a`/`45e8901` (connecting an installation the user already has) — and
§2 was NOT re-run for either. Every build behind those releases used
`docker-compose.override.yml`, i.e. the SIBLING checkouts, so the committed
configuration at these gitlinks is untested exactly as §1 describes.

The first of those two releases also left this marker naming the PREVIOUS gitlinks, so
the gate was red on `main` and silently so: root's unit suite was run before the
submodule bumps were staged, and `committedGitlinks()` reads the index — so the guard
was evaluated against the pre-bump state and passed. Staging the bump before running the
suite is what makes this gate mean anything, and it is the same ordering that
`supagloo-nodejs-dbos`'s `dockerfile-database-lib-pin` test enforces.

§2 must run before these gitlinks are deployed.

**Verified 2026-07-29 (second run), after the api + nextjs releases.** Compose already
builds from the submodules (§1), so §2 reduced to: confirm no override exists,
`docker compose build --no-cache migrate api dbos nextjs`, `docker compose up -d` with
`migrate` reporting *"No pending migrations to apply."*, then root's full e2e — **5 files
/ 19 tests**, with all eight `boot-hardening` cases confirmed executed via
`--reporter=verbose` and **E-BH8** green. Re-run once more after the Gloo-connect helper shipped in nextjs `22335fd`; only the nextjs gitlink had moved, so only its image was rebuilt cold — the api and dbos images were already from the pointers this marker names.

This run also fixed the guard itself. `committedGitlinks()` read `git ls-tree HEAD`, so a
STAGED gitlink bump was invisible to it: both the nextjs and api pointers were staged at
new commits while the marker still named the old ones, and the suite passed. §3 had
described index-reading behaviour for weeks — only the code disagreed. It now reads
`git ls-files -s`, so `git add <submodule>` arms the guard and the staleness surfaces
before the commit rather than after it.

**Verified 2026-07-29, seven-feature round.** `docker-compose.override.yml` was moved aside,
`docker compose build --no-cache migrate api dbos nextjs` rebuilt all four images from the committed
submodule contexts, `docker compose up -d` completed with `migrate` reporting *"No pending migrations
to apply."*, and root's full e2e ran green: **5 files / 19 tests**, with all 8 `boot-hardening` cases
individually confirmed to execute (E-BH1..E-BH8, real per-case timings 69 ms–1106 ms — not skipped).
**E-BH8 passed**, so the committed nextjs image serves the container's runtime `YV_APP_KEY` with no
build-time placeholder — the case that fails if the nextjs gitlink is stale.

This run is also why the override was retired rather than restored afterwards. At the moment of the
run the three gitlinks were **byte-identical to the sibling checkouts** — the release had just bumped
them to the released mains, and the siblings sat on version branches cut from those same commits — so
moving the override aside cost one cold rebuild instead of a second round of verification, and proved
the committed configuration for the first time in the repo's history. Putting it back would have
re-introduced the only reason the two could ever disagree. From here §2 is a cheap confirmation after
each gitlink move, not a separate expedition.

**Verified 2026-07-30, the wizard-redirect / scripture-carry-through round.** All three code gitlinks
moved (nextjs `dcd7dcc`→`062a09b`, api `255131e`→`51283fd`, dbos `49f83ac`→`80829d0`), so §2 ran in
full. No `docker-compose.override.yml` existed and `docker compose config` reported all four contexts
under `./supagloo-*`. `docker compose build --no-cache migrate api dbos nextjs` rebuilt every image
from the committed submodule contexts, `docker compose up -d` completed with `migrate` reporting
*"No pending migrations to apply."*, and root's full e2e ran green: **5 files / 19 tests**, with all
eight `boot-hardening` cases individually confirmed to execute under `--reporter=verbose` (E-BH1..E-BH8,
real per-case timings 84 ms–1109 ms — not skipped). **E-BH8 passed at 1109 ms**, so the committed nextjs
image serves the container's runtime `YV_APP_KEY` with no build-time placeholder.

The db-lib release in this round (`60c3691`→`fc5cf2c`) is docs + barrel-guard only, and its pointer was
bumped with `ARG DATABASE_LIB_REF` in the same commit in both api and dbos, per each repo's
`dockerfile-database-lib-pin` test. Both of those tests were confirmed red before staging the gitlink
and green after — which is the ordering this document's §3 note about `git ls-files -s` describes.

**Re-verified at nextjs `5d0837d`** after a second nextjs release in the same round (the e2e harness
fixes). Only the nextjs gitlink moved, so only its image was rebuilt cold; api and dbos were already
from the pointers this marker names. `docker compose up -d`, `migrate` clean, root's full e2e green
again: **5 files / 19 tests**, all eight boot-hardening cases executed (70 ms–1166 ms), **E-BH8 green
at 1166 ms**.

**This round also fixed a Compose defect that no gitlink could have healed.** `docker-compose.yml`
passed `YOUVERSION_APP_KEY` to the `nextjs` service and to **nothing else**, while the dbos worker
reads it (`src/config/env.ts`) and sends it as `x-yvp-app-key` (`src/providers/youversion.ts`). Every
scripture read from the worker answered **401**, non-retryably, so a storyboard generation for a
project with a chosen passage failed with the cause three services away. It survived because the path
was *unreachable*, not merely untested: `generateScript` only fetches a passage when the manifest has
a `scripture` block, and every e2e fixture in every repo was a `createdFrom: "blank"` project without
one. `.env.example` had described the variable as *"already wired — dbos sends it as a header"*, which
was true of the code and false of the wiring; that sentence is corrected, and
`tests/unit/dbos-compose.test.ts` now holds the line (confirmed red with the line removed).

This is the class of defect §1 says building from the submodules makes *nameable* but not *proven* —
here the images were right and the environment handed to them was not, which is why the gate's e2e
step is a run and not an inspection.

**Verified 2026-07-30 (Step 13) at nextjs `2596e64` / api `51283fd` / dbos `2db0081` — the run this
marker now names.** Two gitlinks moved after the run recorded immediately above (nextjs
`5d0837d`→`2596e64`, dbos `80829d0`→`2db0081`; api unchanged), so §2 ran in full and cold.

Why it was re-run from scratch rather than inherited. An earlier green measurement existed for this
round and was **discarded**, for two independent reasons, and recording it would have been the exact
staleness §1 describes:

1. `tests/e2e/boot-hardening.e2e.ts` was **rewritten after those numbers were measured** — commit
   `07e32be` changed `runOneOffWithout`'s docker argv. Numbers measured against a different spec are
   not evidence about this one.
2. The stack those numbers came from was **not one coherent cold build**: the `dbos` image had been
   rebuilt on its own during the E-BH9 mutation experiments, so the four images were from different
   moments. `--no-cache` on all four in a single invocation is what makes them one artefact.

**The run.** No `docker-compose.override.yml` existed and `docker compose config` reported all four
contexts under `/Users/ash/code/supagloo/supagloo-*` (the submodules). All three submodule checkouts
were clean and byte-equal to the index gitlinks, with db-lib pinned at `fc5cf2c` in all three — so the
build contexts really were the trees this marker names. `docker compose down` first, then
`docker compose build --no-cache migrate api dbos nextjs` rebuilt every image in **239 s** (exit 0,
all four re-tagged), `docker compose up -d` brought the stack up in 8 s with `migrate` exiting **0**
and reporting *"No pending migrations to apply."*, and the worker logged `DBOS launched!` with its four
queues — itself now a live check that root's `.env` carries a non-empty `YOUVERSION_APP_KEY`, because
since dbos `2db0081` a blank one takes the worker DOWN rather than degrading it.

Root's full e2e then ran green: **5 files / 20 tests** (19 before E-BH9), lane wall time **6.53 s**,
with all **nine** boot-hardening cases individually confirmed to execute under `--reporter=verbose` —
E-BH1 625 ms, E-BH2 496 ms, E-BH3 503 ms, E-BH4 479 ms, **E-BH9 491 ms**, E-BH5 745 ms, E-BH6 671 ms,
**E-BH8 1153 ms**, E-BH7 76 ms. Not skipped. Both gitlink-sensitive cases passed: **E-BH8** (nextjs —
this round changed nextjs source) and **E-BH9** (dbos — the new boot gate).

**E-BH9 was read, not counted**, per §2 step 5. A pass/fail summary is not diagnostic for it: on a
stale dbos image the worker never exits, the harness kills it, and `status: -1` would satisfy a naive
non-zero check. The probe was re-run by hand against the same image and its `RunResult` printed:
`timedOut: false`, `status: 1`, no Node `ETIMEDOUT`, elapsed **583 ms**, refusing with *"Invalid
environment configuration in supagloo-nodejs-dbos/src/config/env.ts — YOUVERSION_APP_KEY: Invalid
input: expected string, received undefined"*. That is the **required-ness** path — `received
undefined`, not a `min(1)` complaint about `""` — i.e. the discriminating one.

**Two defects in the harness itself were fixed before this run, so the run certifies the fixed spec.**
Both were surfaced reviewing Step 12 and folded into this round rather than deferred:

- **`runOneOff` had no container-leak guard.** `runOneOffWithout` was given `--name` + a
  `docker rm -f` in a `finally`; `runOneOff`, which backs E-BH1–E-BH6, was not — so five cases kept
  the hole while the sixth was fixed. That is newly reachable rather than theoretical: now that
  `classifyFailure` actually DETECTS a hang (`ETIMEDOUT`) instead of misreading it as a clean exit,
  `runOneOff`'s 120 s timeout path can fire and leave a container outliving the killed CLI — leaking a
  service into the shared stack, which is the hazard the spec's own header is about. The naming and the
  force-remove now live in shared helpers, once, for the same reason `classifyFailure` does: there is
  nothing left to copy. Verified after this run — `docker ps -a` matched **zero** containers on
  `supagloo-bh`, `supagloo-dbos-run`, `supagloo-nextjs-run` or `supagloo-api-run`, with only the
  long-lived stack remaining.
- **E-BH9's `node dist/main.js` was hardcoded**, silently coupling root's spec to a value in another
  repo. `--entrypoint env` (what makes `env -u VAR` possible) discards the image's `CMD`, so the case
  must name the entry point — but naming it literally means a dbos entry-point change leaves this case
  launching the old one, where a missing module also exits non-zero and also prints no
  `YOUVERSION_APP_KEY`, so it would fail for a reason unrelated to the boot gate. It now **derives** the
  command from the dbos submodule's Dockerfile `CMD` (the same build context Compose uses, not the
  `~/code` sibling), and fails loudly if that file grows an `ENTRYPOINT` or drops its exec-form `CMD`.
  The pin is structural, so there is no value left to drift. Confirmed at run time: derived
  `["node","dist/main.js"]`, no `ENTRYPOINT` — identical to what was hardcoded, which is why this was a
  latent coupling rather than a live bug.

Root's unit lane was **321/322 before** this marker was written, red on exactly
`committed-config-gate` RX-9 because §3 still named the previous SHAs — by design, and the thing this
edit resolves — and **322/322 after**, with the gitlinks staged so `git ls-files -s` arms the guard.

---

**Verified 2026-07-30 (Step 13) at nextjs `a89a09d` / api `4190c1e` / dbos `5986d3f` — the
narrator-voice / audio-mix round, and the run this marker now names.** All three code gitlinks moved
(nextjs `1446b09`→`a89a09d`, api `51283fd`→`4190c1e`, dbos `2db0081`→`5986d3f`), so §2 ran in full and
cold. `supagloo-database-lib` was untouched by this round and was **not released**; both consumers
stayed pinned at `ARG DATABASE_LIB_REF=fc5cf2c`, unchanged, so no `dockerfile-database-lib-pin`
ordering applied here.

**The run.** No `docker-compose.override.yml` existed and `docker compose config` reported all four
contexts under `/Users/ash/code/supagloo/supagloo-*` (the submodules). All three submodule checkouts
were clean and byte-equal to the staged gitlinks. Root's `.env` carried a non-empty
`YOUVERSION_APP_KEY`. `docker compose down` first, then `docker compose build --no-cache migrate api
dbos nextjs` rebuilt every image in **132 s** (exit 0, all four re-tagged), `docker compose up -d`
brought the stack up in **7 s** with `migrate` exiting **0** and reporting *"No pending migrations to
apply."*, and the worker logged `DBOS launched!` with its four queues — the live confirmation that the
app key is present, since dbos `2db0081` a blank one takes the worker DOWN rather than degrading it.

Root's full e2e then ran green: **5 files / 20 tests**, lane wall time **6.82 s**, with all **nine**
boot-hardening cases individually confirmed to execute under `--reporter=verbose` — E-BH1 656 ms,
E-BH2 527 ms, E-BH3 505 ms, E-BH4 651 ms, **E-BH9 544 ms**, E-BH5 744 ms, E-BH6 644 ms,
**E-BH8 1156 ms**, E-BH7 89 ms. Not skipped.

**Both gitlink-sensitive cases were READ, not counted**, per §2 step 5 — each re-run by hand against
the same cold-built images, whose ids were checked to match the running containers:

- **E-BH9 (dbos).** A pass/fail summary is not diagnostic for it: on a stale image the worker never
  exits, the harness kills it, and `status: -1` satisfies a naive non-zero check. The probe printed
  `timedOut: false`, `status: 1`, no Node `ETIMEDOUT`, elapsed **498 ms**, refusing with *"Invalid
  environment configuration in supagloo-nodejs-dbos/src/config/env.ts — YOUVERSION_APP_KEY: Invalid
  input: expected string, received undefined"* — the **required-ness** path (`received undefined`, not
  a `min(1)` complaint about `""`), i.e. the discriminating one. The derived command was
  `["node","dist/main.js"]` with no `ENTRYPOINT`, read from the submodule's Dockerfile.
- **E-BH8 (nextjs).** `GET /` answered **200 in 651 ms**; in 143 248 bytes of body the container's
  runtime `YV_APP_KEY` appeared **exactly once** and `build-time-placeholder-not-a-real-key`
  **zero times**, with no `boot refused` in the container's logs. This round changed nextjs source,
  so that case was load-bearing rather than ceremonial.

**`E-MC6` was executed after the cold rebuild, and it PASSED** (26 ms; `studio-model-cost.e2e.ts`,
1 passed / 5 skipped, lane 67.06 s). It is the only executable check of this round's premise — that
`supported_voices` survives the api mapper → Fastify response serializer → nextjs contracts → picker
as a **composed chain** — because every unit test on that path is fixture-fed and proves nothing about
what the provider publishes or about the three `z.object` mirrors composing. It asserted the narration
select is narrowed to `resolveGenerationTarget("narration")`, that the live catalogue's `voices` for
that model is non-null and non-empty, and that every option the voice select offers is one the
provider named. Sequencing mattered: it was run against the api container built from the **bumped**
gitlink (image id verified against the running container), because only that api serves `voices`.

**A finding about the fixture knob, recorded because the cheap path does not exist.**
`SUPAGLOO_E2E_STUDIO_SLUG` is meant to let a spec reuse an already-populated project instead of
creating a GitHub fixture repo and paying for a storyboard generation — `studio-hydration.e2e.ts`
describes it as "the release harness seeds/imports a populated-manifest project and exposes its slug".
**No such harness exists, and the knob cannot work as written.** Every project read in the api is
owner-scoped (`projects-service.ts` — `where: { id, ownerId: userId }`), and each spec seeds its user
as `yv-e2e-returning-<RUN_ID>` with a fresh random `RUN_ID` minted at module load, so a fixture
project from any earlier run belongs to a different user. Measured here: pointing the knob at a real
5-scene fixture project failed with *"[data-testid=\"script-input\"] never appeared within 60000ms"* —
the owner-scoped 404, not a missing project. E-MC6 was therefore run on the spec's own
`createProjectViaExistingEmptyRepo` path, which added **one** fixture repo (28 → 29) and one real
storyboard generation. Either the knob needs a seeding step that re-owns a fixture project to the
run's user, or the specs need a way to pin the seed nonce; until one of those exists the knob is
inert and should not be quoted as a cost saving.

Root's unit lane was **321/322 before** this marker was written, red on exactly
`committed-config-gate` RX-9 with the diff naming the three new SHAs against the three old ones — by
design, and what this edit resolves — and **322/322 after**, with the gitlinks staged so
`git ls-files -s` arms the guard. `docker ps -a` matched **zero** containers on `supagloo-bh`,
`supagloo-dbos-run`, `supagloo-nextjs-run` or `supagloo-api-run` before and after, with only the
long-lived stack remaining.
