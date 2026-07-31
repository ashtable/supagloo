---
name: nextjs-real-lane-builds-api-from-the-submodule-pointer
description: The nextjs real e2e lane runs `next dev` from the SIBLING checkout but builds the api/dbos containers from the ROOT repo's SUBMODULE POINTERS — so nextjs edits are live instantly and api edits are invisible until the pointer moves; the sanctioned way to validate in-flight api code is to fast-forward the submodule working tree to a PUSHED commit
metadata:
  type: constraint
---

Two halves of the same lane, with opposite update semantics. Getting this wrong costs a
full ~12-minute lane run that measured the wrong binary.

| component | where it comes from | when an edit takes effect |
|---|---|---|
| the app under test | `next dev`, spawned by `tests/e2e/global-setup.ts` in the **sibling checkout** (cwd) | immediately |
| `api`, `dbos` | `docker compose build` from the **root repo's submodule directories** | only when the submodule pointer moves |

The lane says so itself, in one line that is easy to scroll past:

> `[global-setup.render] note: …/docker-compose.override.yml is absent, so the api + dbos
> containers build from the SUBMODULE pointers, not the sibling working checkouts.
> In-flight api/dbos changes will not be present.`

## The override that would do this for you — and why you cannot rely on it

`global-setup.render.ts`'s `composeFiles()` adds root `docker-compose.override.yml` when it
exists, and that file is what "redirects the api/dbos build contexts at the sibling working
checkouts instead of the submodule pointers". **It is absent in this environment** (the
user retired it), which is exactly what the note above is telling you. Do not re-create it
to make a lane pass: a container built from an uncommitted working tree proves nothing
about what will ship.

## How to validate an in-flight api change WITHOUT releasing

Not a symlink, not a re-created override, not `file:` trickery
([[in-flight-dblib-e2e-constraint]] is the general form of that rule):

1. commit and **push** the api on its version branch;
2. in root: `cd supagloo-nodejs-api && git fetch origin && git checkout <sha>` — this moves
   the submodule's **working tree**, leaving root with an uncommitted gitlink change;
3. `docker compose build api && docker compose up -d api` (or just let the lane's own
   global setup rebuild — it builds api/dbos every run);
4. run the lane.

Step 2 is a real, pushed commit, so nothing is faked — this is the "bump/fast-forward/
rebuild" path, not the forbidden local-override path. **Leave the gitlink uncommitted and
say so in the report**: formalising it belongs to the release, which the user drives.

Applies only when the change is api/dbos-local. A change that also touches **db-lib**
still needs a db-lib release first, because both Dockerfiles clone it at a pinned
`DATABASE_LIB_REF` — see [[in-flight-dblib-e2e-constraint]].

Related: [[the-nextjs-real-lane-is-not-in-any-release-gate]],
[[real-github-e2e-harness]], [[compose-infra-and-root-test-harness]].
