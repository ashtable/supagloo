---
name: optional-does-not-weaken-min1-for-empty-strings
description: "A probe that BLANKS an env var cannot tell z.string().min(1) from z.string().min(1).optional() — `.optional()` permits only `undefined`, so every empty-string boot test is non-discriminating for a required-ness change"
metadata:
  type: constraint
---

**`z.string().min(1).optional()` rejects `""` exactly as firmly as `z.string().min(1)` does.**
`.optional()` widens the type to admit `undefined` and nothing else. So any test that proves
required-ness by setting a variable to the EMPTY STRING is green both before and after the
promotion, and proves nothing about it.

This bit twice in one change (2026-07-30, promoting dbos's `YOUVERSION_APP_KEY` to
required-at-boot):

1. **dbos unit lane.** `env.test.ts` runs two `it.each(REQUIRED)` blocks — a *missing* case
   (`{[name]: undefined}`) and an *empty* case (`{[name]: ""}`). Restoring `.optional()` reds
   only the **missing** one. The empty case was already passing under the old schema. The
   changelist predicted "both go red"; only one does. **The missing case is the sole
   discriminator.**
2. **root's Compose e2e.** `E-BH9` was specified as
   `runOneOff("dbos", { YOUVERSION_APP_KEY: "" })`. With `.optional()` restored and the image
   rebuilt, that **refused to boot in 783 ms and PASSED** — for the `min(1)` reason, not the
   required-ness one. It would have been green before the change too.

**How to write the discriminating probe.** Genuinely remove the variable from the process
environment. `docker compose run -e VAR=` sets an empty string; there is no `-e` form that
unsets. Use `--entrypoint env` and pass the service's command explicitly:

```
docker compose run --rm --no-deps --name <n> --entrypoint env <service> -u VAR node dist/main.js
```

**Which case models which real failure — both are worth having, for different reasons.**
Compose always substitutes a declared variable (to `""` when root's `.env` omits it), so:
- `""` is the **operator-forgot-to-set-it** case. It was already failing closed.
- genuine **absence** is the **missing-Compose-wiring** case — the variable not passed to the
  service block at all. That is the defect this round actually found
  ([[dbos-worker-had-no-youversion-key]]), and the only one the promotion changes.

So promoting an optional-but-`min(1)` variable to required does **not** change behaviour for a
blank value. It changes behaviour only where the variable is genuinely absent: outside Compose,
or in a deployment (Railway) that never defines it. Say that precisely rather than claiming the
promotion "makes it fail closed", which it already did for the common case.

Related: [[e2e-boot-probe-timedout-needs-etimedout]] (the second defect found proving the same
case), [[dbos-worker-had-no-youversion-key]].
