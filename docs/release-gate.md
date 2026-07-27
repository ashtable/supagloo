# The committed-configuration gate

**One question: has anybody ever run this repo's e2e suite against the trees
`docker-compose.yml` actually names?**

Today the answer is no, and that is what this document exists to stop being invisible.
`tests/unit/committed-config-gate.test.ts` enforces every claim below.

---

## 1. Why the gate exists (RX-9)

`docker-compose.yml` builds four services from root's **submodules**:

```
migrate  ->  ./supagloo-nodejs-api
api      ->  ./supagloo-nodejs-api
dbos     ->  ./supagloo-nodejs-dbos
nextjs   ->  ./supagloo-nextjs
```

A gitignored `docker-compose.override.yml` redirects all four to the **sibling** checkouts
at `~/code/*`. That override is legitimate and deliberate: root's gitlinks are bumped in a
later workflow step, so until then the override is the only way `docker compose up --build`
exercises in-flight code. Step 8 judged it explicitly against the memory
`feedback-never-fake-submodule-resolution` and it is **not** that failure mode — that memory
is about db-lib, and db-lib went through a real release, real gitlink bumps in three
consumers, and a matching `ARG DATABASE_LIB_REF` in two Dockerfiles.

The residual is still real, and it is the one this gate covers: **root's green e2e was
obtained only with the override active.** After the gitlinks are bumped, `docker compose up
--build` uses the submodule contexts, and nobody will have run `boot-hardening.e2e.ts`
against those images. Releasing on a configuration nothing has executed is the shape that
memory forbids trusting, even when the reason it happened is sound.

Two of the four services make this concrete rather than theoretical:

- **dbos** — Step 8's M13 confirmed the submodule tree and the sibling tree **differed**:
  the submodule had no `src/workflows/render/media-options.ts` at all, and still carried a
  registry comment the sibling had corrected.
- **nextjs** — the sibling carries item 7's terminal boot refusal and item 8's per-request
  `YV_APP_KEY` read. An image built from the un-bumped submodule fails **E-BH5**, **E-BH6**
  and **E-BH8**. That is why the rebuild must happen **after** item 8's fix has propagated
  into the gitlink, never before.

---

## 2. The procedure

Run it after db-lib's release and after every consumer gitlink + `ARG DATABASE_LIB_REF`
sync, and after root's own three gitlinks are bumped. In order:

1. **Bump root's three code gitlinks** to the released commits
   (`supagloo-nextjs`, `supagloo-nodejs-api`, `supagloo-nodejs-dbos`).
2. **Move `docker-compose.override.yml` aside** — `mv docker-compose.override.yml
   docker-compose.override.yml.bak`. Do not edit it; the point is to run with it absent, and
   both `tests/e2e/global-setup.ts` and `tests/e2e/boot-hardening.e2e.ts` include it
   conditionally and behave correctly when it is gone.
3. **Rebuild all four services from the committed contexts**, cold:
   `docker compose build --no-cache migrate api dbos nextjs`. `--no-cache` is not
   superstition — a cached layer keyed on an identical `package.json` would silently reuse a
   build of the sibling tree.
4. **Bring the stack up** and let `migrate` complete: `docker compose up -d`.
5. **Run root's full e2e**: `npm run test:e2e`. It must include **E-BH8**, the healthy-nextjs
   case, which is the one that fails if the nextjs gitlink predates item 8.
6. **Record the result below**, then restore the override if you are going back to
   in-flight work.

Anything less means the shipped configuration is untested.

---

## 3. The record

The line below is machine-read. It is either `not-yet`, or the three gitlink shas the run
was verified at — and if it names shas, they must equal root's gitlinks **right now**. Bump
a submodule pointer without re-running §2 and the gate goes red, which is the entire point.

```
COMMITTED-CONFIG VERIFIED AT: not-yet
```

To record a verified run, replace `not-yet` with the three shas, space-separated, e.g.
`COMMITTED-CONFIG VERIFIED AT: <nextjs-sha> <api-sha> <dbos-sha>`, taken from
`git ls-tree HEAD supagloo-nextjs supagloo-nodejs-api supagloo-nodejs-dbos`.

**State at the time of writing (Step 11):** `not-yet`. Root's gitlinks are
`supagloo-nextjs 41d2416`, `supagloo-nodejs-api 4a6e4ec`, `supagloo-nodejs-dbos da194db`,
all of which predate this run's work in those repos. Every e2e figure anyone quotes from
root today was measured against the sibling checkouts.
