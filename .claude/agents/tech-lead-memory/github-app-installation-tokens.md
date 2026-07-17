---
name: github-app-installation-tokens
description: Confirmed 2026-07-17 — GitHub App (not OAuth app); store only installationId, mint short-lived installation tokens on demand
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
