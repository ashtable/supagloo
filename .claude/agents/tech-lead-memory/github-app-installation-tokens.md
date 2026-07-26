---
name: github-app-installation-tokens
description: GitHub App (not OAuth app); store only installationId, mint short-lived installation tokens on demand; the JIT zero-storage create-new-repo hop — and the two real-GitHub findings task 62 made about it (missing auto_init = plan row 63; 200-with-error exchange)
metadata:
  type: decision
---

Supagloo uses a **GitHub App with per-repo installation**, not a classic
OAuth app. `GithubConnection` stores only `installationId` (+ `githubLogin`,
`repositorySelection`) — **no long-lived repo token at rest**. Whenever the
API or a DBOS worker needs GitHub access, it signs a ~10-min App JWT with
`GITHUB_APP_PRIVATE_KEY` (`GITHUB_APP_ID` as issuer), exchanges it via
`POST /app/installations/{installationId}/access_tokens` for a ~1-hour token
scoped to the granted repos, uses it, and discards it. Every git-ops DBOS
workflow starts with a `mintInstallationToken` step.

**Why:** wireframe 11a promises "Never touch repos you don't select" —
classic OAuth `repo` scope cannot deliver that (account-wide). Installation
scoping can; short-lived tokens also remove the need to encrypt/rotate
stored GitHub credentials (see [[composition-source-of-truth-in-repo]]).

**Trade-offs:** more complex install/callback flow (installation_id
redirect, App JWT minting) vs. classic OAuth's simple code exchange;
accepted for the security/promise fit.

**Create-new-repo exception (added 2026-07-17).** Installation tokens have a
hard limit: they **cannot create repositories in a personal account**, and a
repo created out-of-band is **not auto-added to a `selected` installation**.
So the *create-new-repo* project origin does a **JIT (just-in-time)
user-authorization hop** at project-creation time (API/BFF layer, *not* the
DBOS scaffold workflow, which has no user context): user-auth redirect →
server-side code exchange → **short-lived user access token** → used **once**
for `POST /user/repos` (+ `PUT /user/installations/{id}/repositories/{repoId}`
if `selected`) → **discarded**. **No user/refresh token is ever stored** —
zero storage, preserving the no-repo-credential-at-rest principle.
*use-existing-empty-repo* and *import* need no hop. The scaffold workflow's
first git step is therefore `ensureRepoAccessible` (idempotent reachability
check), **not** `createGithubRepo`. **Refresh-token storage was considered and
rejected** (reintroduces a per-user credential at rest for a one-time op).

**VERIFIED AGAINST REAL GITHUB 2026-07-25 (task 62), with two findings:**

1. **`createUserRepo` sends no `auto_init`**, so the repo it creates has zero
   commits and no `main` ref — and `scaffoldProjectWorkflow` then opens its base
   PR with `base: "main"`, which real GitHub **422s**. The designed create-new
   path therefore does not work end to end today. The task-9 stub hid this
   completely by claiming `default_branch: "main"` in its create response while a
   SEPARATE git-server fixture independently seeded a real `main` — two fake
   backends sharing no storage. **Plan row 63**; a correct fix is a design
   decision (it touches `ProjectVersion`'s PR-number nullability), not a patch.
2. **The exchange's failure mode is not what the code assumed**: real GitHub
   returns HTTP **200** with `{"error":"bad_verification_code"}`, so an `res.ok`
   check treats a failure as success. Fixed in task 62 with a typed
   `GithubUserAuthExchangeError`.

Also live-verified: the installation grants `contents:write` +
`pull_requests:write` + `metadata:read` and **no `administration`** — which is
why the e2e harness creates fixture repos with a PAT and does everything else
with the installation token ([[real-github-e2e-harness]]).
