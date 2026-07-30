---
name: e2e-boot-probe-timedout-needs-etimedout
description: "A 'refused to boot' probe wrapping `docker compose run` cannot detect a hang via `status === null` — the CLI traps SIGTERM and exits POSITIVE, so timedOut read false on a 120s hang; use Node's `code === 'ETIMEDOUT'`, and force-remove the container by --name in a finally"
metadata:
  type: gotcha
---

Root's `tests/e2e/boot-hardening.e2e.ts` proves services *refuse to boot* by running
`docker compose run --rm --no-deps <service>` under `execFileSync` with a `timeout` and
asserting a non-zero exit. Two things about that shape are wrong in ways that only show up on
the path nothing normally exercises — the **hang**.

## 1. `status === null` does not detect a hang here

`RunResult.timedOut` was `e.status === null || e.status === undefined`, with a comment
explaining that a hang yields `status: null` and that `?? -1` would otherwise satisfy
`not.toBe(0)`. That reasoning is right for a plain child (`execFileSync("sleep", …)` on timeout
gives `status: null, signal: "SIGTERM", code: "ETIMEDOUT"`) and **wrong for this one**: the
child is the `docker compose` CLI, which traps the SIGTERM, stops its container, and exits with
a **positive status of its own**. So `e.status` is a number and `e.signal` is undefined.

**Measured 2026-07-30** against a deliberately-hung dbos worker (boot gate reverted): the run
took **120 022 ms** and both `expect(timedOut).toBe(false)` and
`expect(status).toBeGreaterThan(0)` **PASSED**. The case only went red on a later
`toContain` — i.e. red by luck of assertion order, after two minutes, rather than on the guard
written to catch exactly this. `E-BH5`/`E-BH6` carried the same hole latently; they pass in
~700 ms, so the kill path had never run.

**Fix:** classify on Node's own `e.code === "ETIMEDOUT"`, which is set by Node when it kills the
child for the timeout and is independent of what the child does with the signal. Keep the
`status == null` clause as well; put the whole thing in ONE `classifyFailure(err)` used by every
helper, because a second copy re-opens it.

## 2. `--rm` does not clean up on the timeout path

`--rm` removes a container when it **exits**. A hang is precisely the case where it does not.
When the harness SIGTERMs the CLI, the container can outlive it: the two mutation runs that
proved this case each left a `supagloo-dbos-run-<hash>` container **`Up`** — extra live workers
polling the same queues as the long-lived `dbos` service. That is the hazard the spec's own
header warns about ("that would break ANOTHER REPO'S LANE, invisibly"), and it bites hardest on
a genuine regression: the boot gate breaks, the case reds, *and* it leaks a worker.

**Fix:** pass an explicit `--name` and `docker rm -f` it in a `finally`. Do not rely on the CLI
surviving long enough to honour `--rm`. Silent removal is correct — on the normal path `--rm`
already got it, so "No such container" is expected.

## 3. Size the timeout to the measurement

A boot refusal in this suite is sub-second (E-BH1..E-BH9 measure **70–1143 ms**). A worker that
boots is proved by *not* exiting, so the timeout IS the assertion — but it does not need to be
120 s. 30 s is two orders of magnitude of slack and turns a 2-minute red into a 30-second one.

After both fixes the discriminating mutation reds the case in 30 s directly on
`timedOut` — *"the worker never exited — it booted without the key"* — which is the failure
message a future reader needs.

Related: [[optional-does-not-weaken-min1-for-empty-strings]] (the other defect found proving the
same case), [[a-guard-satisfied-by-its-own-residue]], [[no-long-running-samplers-to-prove-a-precondition]].
