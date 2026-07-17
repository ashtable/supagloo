---
name: prisma-exact-version-pin
description: Requirement (2026-07-17) — API and DBOS repos must pin the exact same Prisma version as database-lib, enforced by a CI/postinstall check
metadata:
  type: constraint
---

`supagloo-nodejs-api` and `supagloo-nodejs-dbos` **MUST pin the exact same
`prisma`/`@prisma/client` version as `supagloo-database-lib`** — exact
version match, never a semver range.

**Enforcement:** `database-lib` exports its pinned Prisma version (a
`PRISMA_VERSION` constant plus a `supagloo.prismaVersion` package.json
field); each consumer runs a CI check or postinstall script that fails when
its own pinned version differs.

**Why:** the generated Prisma client shipped in `database-lib`'s `dist/` is
version-coupled to the Prisma runtime in each consumer; a mismatch produces
subtle runtime breakage rather than an install-time error.
