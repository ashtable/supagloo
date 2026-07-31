---
name: create-repo-visibility-gate-needs-a-user-to-server-token
description: The api's `awaitInstallationVisibility` walks `GET /user/installations/:id/repositories`, which GitHub serves ONLY to a user-to-server token — so row 66's synthetic exchange (a classic PAT) 403s forever, and the BFF's 30 s backstop was hiding the api's own 60 s error behind a generic 504
metadata:
  type: constraint
---

Measured 2026-07-31 while classifying `E-RNP1b`, which failed at **exactly 30.0 s** on two
consecutive full-lane runs. An identical duration to the tenth of a second is a ceiling,
never latency — read it as a timeout constant every time.

## Two independent faults, stacked

**1. The 403.** `RepoProvisioningService.awaitInstallationVisibility` (added in api
`f441639`) polls `listInstallationRepos`, which hits
`GET /user/installations/{id}/repositories` with `authorization: token <jitUserToken>`.
GitHub serves that endpoint to **GitHub App user-to-server tokens only** and answers:

> 403 — You must authenticate with an access token authorized to a GitHub App, a personal
> access token, or basic auth in order to list repositories for an installation.

⚠️ **This was ALREADY KNOWN and already documented in the code**, in the
`InstallationRepoLister` docblock at `repo-provisioning-service.ts:40` — which names the
403 verbatim, explains that the api's OWN e2e injects an installation-token lister to get
round it, and states the intended production fix ("`githubAppClient.listInstallationRepos`,
already built one scope away in `server.ts` … a one-line change in `server.ts`, a file this
pass does not own"). The 2026-07-31 sweep rediscovered it from the outside because the
nextjs e2e drives the containerised api, which uses the DEFAULT lister and therefore has no
such workaround. **Read that docblock before re-deriving any of this.** The genuinely new
half of the finding is the timeout ordering below, not the 403.

Row 66's double-gated test exchange cannot mint one — it hands back
`GITHUB_E2E_EXCHANGE_TOKEN`, a **classic PAT**. Verified directly against api.github.com:
**both** `GITHUB_E2E_EXCHANGE_TOKEN` and `GITHUB_E2E_PAT_TOKEN` get 403. Production's real
OAuth hop yields a user-to-server token, which the endpoint accepts, so this is a
**test-seam fidelity gap** rather than a proven product fault — but it makes `E-RNP1b`
unpassable in this harness, deterministically, and no amount of retrying changes it.

The fix the docblock names is the right one, and for a reason stronger than "it makes the
test pass": the gate exists to predict dbos's `ensureRepoReachable`, which walks
`GET /installation/repositories`. Probing the **user's** view to predict the
**installation's** view is indirect; probing the installation's own view is byte-for-byte
the read being predicted, and works with a token the api mints for itself.

## 2. The backstop was shorter than the thing it backstopped

`DEFAULT_UPSTREAM_TIMEOUT_MS` is 30 s; the api's `VISIBILITY_DEFAULTS.timeoutMs` is 60 s.
So on this route the BFF **always** gave up first:

- the api's typed `RepoNotVisibleError` (502, naming repo, installation and remedy) could
  never reach the browser — every investigation started from a bare `upstream_timeout`;
- worse, a visibility wait settling between 30 s and 60 s means the api goes on to
  **succeed** while the user is told it failed — on a non-idempotent hop that has already
  created a real GitHub repository. Inviting a retry there is the expensive direction.

Fixed with `PROVISIONING_UPSTREAM_TIMEOUT_MS = 90_000` on that one route, pinned by
`U-PX1` (must exceed the api's 60 s gate — the only thing holding the two constants in
order across a repo boundary they cannot import across) and `U-PX2` (it stays an
exception; raising the global default would re-open the DR3 hang for every page-load
forward).

**The general rule:** whenever a proxy fronts an operation with its own internal budget,
the proxy's timeout must be strictly greater, or the inner component's diagnostics are
unreachable by construction and its successes get reported as failures.

Related: [[real-github-e2e-harness]], [[github-app-installation-tokens]],
[[an-unmounted-wizard-hangs-instead-of-failing]].
