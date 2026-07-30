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
5. **Run root's full e2e**: `npm run test:e2e`. Verify all eight `boot-hardening` cases
   actually executed (`--reporter=verbose`, real per-case timings — a skipped case reads as
   a pass in the summary line). **E-BH8** is the load-bearing one: it fails if the nextjs
   gitlink predates a boot-affecting change.
6. **Record the result in §3.**

Anything less means the shipped configuration is untested.

---

## 3. The record

The line below is machine-read. It is either `not-yet`, or the three gitlink shas the run
was verified at — and if it names shas, they must equal root's gitlinks **right now**. Bump
a submodule pointer without re-running §2 and the gate goes red, which is the entire point.

```
COMMITTED-CONFIG VERIFIED AT: dcd7dcce316150949de9e329dc416ff402021286 255131e2612ba5fb190a3638af766948421f8f4b 49f83aca776f13a7e23fcf79d001ebe14415a9c6
```

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
