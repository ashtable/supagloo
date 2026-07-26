---
name: prisma-migrate-dev-blocked-by-dbos-table
description: "`prisma migrate dev` can never be used against the shared dev database — DBOS owns an out-of-Prisma `noop_proof` table there, so migrate dev reports drift and demands a destructive reset; author migrations against a throwaway scratch DB instead"
metadata:
  type: gotcha
---

**Never run `npx prisma migrate dev` (with or without `--create-only`) against the shared
`supagloo` dev database.** It reports:

```
Drift detected: Your database schema is not in sync with your migration history.
[+] Added tables
  - noop_proof
```

and then demands `prisma migrate reset` — which would **wipe every repo's e2e fixtures**.

**Why:** `noop_proof` is created by `supagloo-nodejs-dbos` at
`src/db/app-db.ts:37` (`CREATE TABLE IF NOT EXISTS noop_proof`) as a deliberately
self-managed, non-Prisma artifact living in the same `supagloo` database (see
[[nodejs-dbos-bootstrap]]). Prisma has no migration for it, so from Prisma's point of view the
dev database is permanently drifted. This is not a bug to fix — the table is intentional — so
the drift is permanent and `migrate dev` is permanently unusable here.

**How to author a migration instead** (the working recipe, task 39/40/41, db-lib v0.0.32):

1. Create a throwaway database, e.g. `supagloo_migscratch`.
2. Point `DATABASE_URL` at it and run `npx prisma migrate dev --create-only --name <name>`.
3. **Review the generated SQL**, then apply it to the real dev DB with
   `npx prisma migrate deploy` — `deploy` does **not** drift-check, which is exactly why it works.
4. **Drop the scratch database.**

**Proving "no drift" also needs a different shape.** `migrate diff --from-migrations` needs
`datasource.shadowDatabaseUrl` in `prisma.config.ts`, which this repo does not set. Prove it by
deploying **all** migrations to a pristine database and diffing that against the datamodel:

```
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

Exit 0 / `No difference detected.` on a pristine DB is the real proof. Running the same command
against the **dev** DB legitimately exits 2 with exactly one difference,
`[-] Removed tables - noop_proof` — that is the DBOS table, not your change. Independently
reproduced by a second agent in the same run.

**Prisma 7.8.0 flag names** (they differ from Prisma 5/6 docs and from what people guess):
`--to-schema` and `--from-config-datasource`, **not** `--to-schema-datamodel` /
`--from-schema-datasource`.

Related: [[dblib-build-chmod-bin]], [[prisma-exact-version-pin]], [[minio-local-s3-parity]]
(Postgres 17 hosts both the app and the DBOS system database).
