---
name: an-unmounted-wizard-hangs-instead-of-failing
description: `drivePolling`'s `if (!aliveRef.current) return` swallows BOTH terminal branches, so unmounting the new-project wizard mid-scaffold leaves it on the provisioning log forever — no ready card, no error card; R3 made that unmount reachable from outside for the first time
metadata:
  type: gotcha
---

`app/_components/project-wizard/new-project-wizard.tsx` `drivePolling`:

```ts
const job = await pollJobUntilTerminal(projectId, jobId, {...});
if (!aliveRef.current) return;          // ← swallows success AND failure
if (job && jobSucceeded(job)) { …setStep("ready") } else { setErrorMsg("Scaffolding failed…") }
```

The wizard's own docblock already names the symptom, from the StrictMode bug it was
written to fix: *"the wizard never advances to `ready` and never shows an error — it just
hangs on step 2."* The `aliveRef.current = true` on every effect RUN closed the StrictMode
path. It did **not** close the general one: any real unmount while a scaffold is in flight
produces the identical hang.

## ⚠️ STATUS: the code shape is real; the E-TW1 link is UNPROVEN

`E-TW1` produced this exact signature once, on 2026-07-31. It then **passed on three
subsequent runs** — once standalone (56 s vs the failing 255 s) and twice in full lanes —
so the trigger was never observed and no `GET /api/connections` fires in the failing
window to explain a `blocked` flip. Treat the swallowed-outcome path below as a real
defect that has not been demonstrated firing, not as a diagnosed incident.
`projectReadyDiagnosis` (in nextjs `tests/e2e/github-e2e.ts`) now reads the DOM at timeout
and will name the class definitively the next time it happens — check its output before
re-deriving any of this.

## Why that stopped being theoretical on 2026-07-31

Before `d0ecd86`, `workspace-home.tsx` rendered `{wizard === "new" && <NewProjectWizard/>}`
— nothing but `setWizard("none")` could unmount it. R3 made the condition

```tsx
{launcherLive && wizard === "new" && !blocked && <NewProjectWizard …/>}
```

where `launcherLive = !firstSignIn` and `blocked` is re-derived **at render time** from
`connections` + `connectionsResolved`. Both are async-settled session state, so the
launcher family can now legitimately swap the wizard out *after* `POST /api/projects` has
created a repo and enqueued a scaffold. The intent/verdict split that makes R3 correct is
also what makes this reachable.

## The diagnostic signature (how to tell it apart from a real scaffold failure)

Read the `next dev` request log, not the assertion:

| symptom | what it means |
|---|---|
| N job polls, then `GET /api/projects/<id>`, then `GET /studio/<slug>` | success |
| N job polls, then **`new-project-error` text** | job reached a terminal FAILED state — a real dbos/GitHub error |
| N job polls (< the 120 s / ~171-poll budget), then **nothing at all** | the loop exited on a TERMINAL job and `aliveRef.current` was already false — the wizard unmounted |

The third row is the one that presents as an anonymous
`project-ready-card never appeared within 240000ms`, whose canned message blames "the DBOS
git-ops worker: running but wedged". That message is misleading here: the worker finished.
`pollJobUntilTerminal` polls at **700 ms** for **120 s** and `fetchJob` never throws
(`catch { return null }`), so a poll sequence that stops early is *always* a terminal job,
never a timeout and never an exception.

## The fix shape

An unmount must not be able to swallow a terminal outcome. Either lift the scaffold's
outcome out of the wizard's lifetime (own it in `workspace-home`/session state, so the
guardrail can swap the *view* without discarding the *job*), or keep the wizard mounted
while a scaffold is in flight and let the guardrail apply only to a fresh open. Do not
"fix" it by widening the e2e timeout — the wait is not the problem.

Related: [[optional-connections-built]], [[a-permissive-default-opens-a-second-doorway]],
[[wizard-ready-card-redirect-needs-a-confirmed-slug]], [[real-github-e2e-harness]].
