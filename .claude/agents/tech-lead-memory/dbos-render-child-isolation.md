---
name: dbos-render-child-isolation
description: How task 36 executes untrusted cloned-repo code — an allowlist-built child env (never {...process.env}), npm ci|install always --ignore-scripts, an NDJSON child protocol, and the verified Remotion Docker/Chromium layer
metadata:
  type: convention
---

Established 2026-07-24 (task 36). The cloned project a render bundles is **user-controlled
code**, so every process that resolves, compiles, or evaluates it runs isolated.

## Scrubbed child environment (`src/workflows/render/child-env.ts`)

`buildScrubbedChildEnv()` builds the child env from a CLOSED ALLOWLIST —
`PATH HOME TMPDIR TEMP TMP LANG LANGUAGE LC_ALL TZ SHELL USER LOGNAME SystemRoot
SYSTEMROOT COMSPEC` — plus explicit `extra`. Default-deny.

This is deliberately the OPPOSITE shape from `scaffold-project/git.ts`'s
`{ ...process.env, ...HERMETIC_ENV, ...opts.env }`, which only ADDS and would leak
`SECRETS_ENCRYPTION_KEY`, `GITHUB_APP_PRIVATE_KEY`, `DATABASE_URL`, `DBOS_DATABASE_URL`,
`S3_ACCESS_KEY`/`S3_SECRET_KEY` into the child. **Do not reuse the git helper's env shape
for anything that runs user code.**

`child-env.test.ts` proves absence by KEY *and by VALUE* (a secret smuggled under a
renamed key is still a leak). Per-user OpenRouter keys are never env vars (decrypted from
ciphertext at call time), so there is nothing to scrub there — don't invent that
requirement.

## `--ignore-scripts` always

`buildInstallArgs(hasLockfile)` → `npm ci --ignore-scripts …` when a lockfile exists,
`npm install --ignore-scripts …` when it doesn't. The generated template ships NO
lockfile, which is why the `install` fallback exists — the design says `npm ci`, and
`npm ci` hard-errors without a lockfile.

## Child protocol (`child-main.ts` ⇄ `child-runner.ts`)

Command in `argv[2]` (`bundle` | `render` | `still`), JSON spec on **stdin** (EOF
terminated), **NDJSON on stdout** (`progress` lines, then one `result` or `error`),
SIGTERM = cancel (the child fires Remotion's `makeCancelSignal()` cancel). The parent
enforces a kill deadline — that IS the "step timeout", since DBOS has none.

The child entry is resolved as `child-main.js` beside `__dirname` when built, else
`child-main.ts` run through `require.resolve("tsx/cli")` — needed because the e2e launches
the DBOS runtime in-process from `src/`. Never shell out to `npx`.

## Docker / Chromium (verified by an actual container build + browser launch)

`node:22-slim` + Remotion's documented apt list — `libnss3 libdbus-1-3 libatk1.0-0
libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1
libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2` + `fonts-noto-color-emoji` +
`fonts-noto-cjk` — then
`node -e "require('@remotion/renderer').ensureBrowser()"` at build time (the programmatic
equivalent of `npx remotion browser ensure`; we deliberately do not install
`@remotion/cli`). Remotion passes `--no-sandbox`/`--disable-setuid-sandbox` itself, so
running as root needs no extra flag. Remotion's guide explicitly warns AGAINST Alpine.

All `remotion*` packages must be the SAME exact version (`REMOTION_VERSION` = 4.0.490,
enforced by `src/remotion/versions.test.ts`) — `@remotion/renderer` was added at that pin.
