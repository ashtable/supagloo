---
name: github-app-pem-normalization
description: GITHUB_APP_PRIVATE_KEY's documented single-line escaped-\n format is normalized in db-lib's signAppJwt (the one choke point) — fixed 2026-07-25 after it broke every DBOS git-ops workflow
metadata:
  type: decision
---

**Fixed 2026-07-25.** db-lib `src/github.ts` exports `normalizePemNewlines(pem)`
and `signAppJwt` applies it before `createSign("RSA-SHA256").sign()`. Released in
db-lib `954342d` (PR #30). Corrects a stale claim in
[[github-app-connection-built]] ("normalized at the client, not in env/db-lib").

**The bug.** `supagloo/.env.example` documents `GITHUB_APP_PRIVATE_KEY` as the
PKCS#1/PKCS#8 PEM on a **single line with escaped `\n`**, "normalized to real
newlines before signing". Nothing did that normalizing in db-lib, so the raw
one-line string went to OpenSSL and threw
`error:1E08010C:DECODER routines::unsupported` (`ERR_OSSL_UNSUPPORTED`). A key in
the **documented** format was guaranteed to fail.

**Blast radius was DBOS-only, not both consumers** — worth knowing, because the
obvious reading of "nothing normalizes it" is wrong:
- `supagloo-nodejs-api` was **never** broken. It has always normalized
  independently, at `makeGithubAppClient` (`src/connections/github-app-client.ts`,
  since task 11's `ff65528`), and every api private-key path routes through that
  factory from `server.ts`. That local copy is now redundant-but-harmless
  (db-lib's version is idempotent on a real-newline key) and was deliberately
  left in place rather than churned out.
- `supagloo-nodejs-dbos` **was** broken: all five workflows (scaffold / import /
  commit / publish, plus `renderWorkflow`'s clone) pass `cfg.githubAppPrivateKey`
  straight into `mintInstallationToken` with no normalization anywhere in the
  repo. `scaffoldProjectWorkflow` died after burning all 4
  `mintInstallationToken` retries.

**Why db-lib's `signAppJwt` and not the env loaders:** it is the single choke
point both consumers reach, and it is literally what the `.env.example` contract
says ("before signing"). Putting it in each service's env loader is what let it
silently go missing in one of the two in the first place. `normalizePemNewlines`
is a named, doc-commented, exported-from-the-module helper (NOT added to the
`index.ts` barrel — that barrel uses explicit named exports, so the package's
public surface is unchanged) precisely so this can't regress invisibly.

**Trade-offs:** `signAppJwt` is no longer a pure pass-through of its input, and
it now silently accepts sloppy keys — accepted, because both formats are
genuinely live in this system and the function is the only place that can see
both. It still throws on a truly malformed key (tested).

**Implementation shape** — order matters:
```ts
privateKey
  .replace(/\\r\\n|\\n/g, "\n")  // escaped CRLF FIRST, else `\r\n` leaves a stray literal \r
  .replace(/\r\n/g, "\n")        // real CRLF → LF, so escaped & real forms stay byte-identical
  .trim();                       // env/shell whitespace; Node accepts a PEM with no trailing newline
```

**The test bar that actually catches this:** "didn't throw" is not enough. The
regression tests (`src/github.test.ts`) sign with the escaped form AND
`createVerify` the signature against the matching public key, and assert that
**both forms of the same key produce an identical JWT** — RS256 is PKCS#1 v1.5,
hence deterministic, so identical output proves the normalization is faithful
rather than merely parseable.

**Why no test ever caught it:** every db-lib/api unit test and the in-process api
e2e supply a freshly `generateKeyPairSync`'d PEM with **real** newlines. The only
thing exercising the documented env format is the containerized full-stack e2e,
which had never been run until 2026-07-24. Lesson: a fixture generated in-process
will never reproduce an env-plumbing format bug — pin the documented wire/env
format explicitly in a unit test.
