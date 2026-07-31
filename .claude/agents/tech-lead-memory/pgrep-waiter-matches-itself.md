---
name: pgrep-waiter-matches-itself
description: "`until ! pgrep -f \"sweep.sh\"` never terminates — the waiting shell's own command line contains the pattern, so pgrep matches the waiter and the loop spins forever; wait on the PID instead"
metadata:
  type: convention
---

The standard "wait for the full e2e sweep to release Docker" instruction handed to agents in
this repo is:

```
until ! pgrep -f "sweep.sh" >/dev/null 2>&1; do sleep 20; done
```

**It deadlocks.** The waiting shell is invoked as `zsh -c '… until ! pgrep -f "sweep.sh" …'`,
so the literal string `sweep.sh` is in that shell's own `argv`. `pgrep -f` matches against
full command lines, excludes only its own PID, and therefore matches **the waiter**. The
condition can never go false. Observed live on 2026-07-31: PID 76941 sat in that loop while
the real sweep (76636) was still running, and would have kept spinning after it exited.

The usual `swee[p].sh` bracket trick does **not** save you here. It only stops the pattern
from matching *your own* command line; any OTHER hung waiter still has the literal
`sweep.sh` in its argv, so a second agent's loop matches the first agent's loop.

**Wait on the PID:**

```
while kill -0 <sweep-pid> 2>/dev/null; do sleep 20; done
```

…or poll the sweep's own terminal marker (`SWEEP COMPLETE` in `sweep-summary.txt`), which is
the honest signal and survives PID reuse. Same shape as the rule in
[[no-long-running-samplers-to-prove-a-precondition]]: watch the thing that actually states
the outcome, not a proxy that can be satisfied by your own residue — cf.
[[a-guard-satisfied-by-its-own-residue]].
