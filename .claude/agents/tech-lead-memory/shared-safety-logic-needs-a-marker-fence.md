---
name: shared-safety-logic-needs-a-marker-fence
description: Two deliberate copies of dbos-lane-isolation.ts were justified by an argument that only covered the schema NAME while they also duplicated the sole gate on an interpolated DROP SCHEMA — fenced with BEGIN/END markers and a root byte-identity test
metadata:
  type: convention
---

Landed 2026-07-26 (review item W4). `src/testing/dbos-lane-isolation.ts` exists in BOTH
`supagloo-nodejs-api` and `supagloo-nodejs-dbos` on purpose (see
[[dbos-e2e-lane-schema-isolation]]).

## The docblock was arguing the wrong thing

It said the copies "cannot meaningfully diverge — the two repos MUST NOT share a lane schema
name". That covers the schema NAME only. The copies also duplicate the **DDL safety logic**:
`LANE_SCHEMA_PREFIX`, `MAX_PG_IDENTIFIER_BYTES`, `LANE_SCHEMA_RE` and
`assertLaneSchemaName` — the *sole* gate between an interpolated
`DROP SCHEMA IF EXISTS "${schema}" CASCADE` and the production `"dbos"` schema. A copy whose
regex was loosened or whose byte cap was raised past Postgres's real limit would look
identical to its sibling and **would still pass its own repo's suite**, because each repo
only ever tests its own copy.

The narrowed docblock now says: the duplication argument is about the file's LOCATION
(routing it through the root checkout would make specs that need no root checkout depend on
one), and the safety region is one rule held identical by an external fence.

## The fence

`// --- BEGIN SHARED DDL SAFETY (byte-identical across api + dbos; drift-guarded) ---`
… `// --- END SHARED DDL SAFETY ---` in both files, plus root
`tests/unit/dbos-lane-isolation-drift.test.ts` (beside the Compose guards — root is the only
checkout that can see both siblings, same reason as `e2e-prefix-single-source.test.ts`).

Design points paid for:

- **Markers, not whole-file identity.** The files are deliberately NOT byte-identical: the
  headers describe different spec populations and the error strings name different call
  sites (`makeDbosEnqueuer` vs `DBOSClient`). A whole-file test fails on day one.
- **Compared as TEXT, never as a hash.** The failure must SHOW the diverging line, because
  the fix is always "make one match the other" — never "update the expected digest".
- **An empty fence proves nothing**, so the guard also asserts the region still contains the
  seven identifiers *and* the four live values (`"dbos_e2e_"`, `63`, the regex, `"dbos"`).
  Byte-equality alone would happily accept both copies being loosened together.
- **Byte-equality would also survive the gate being unhooked**, so a fifth test asserts
  `assertLaneSchemaName(schema);` still precedes the executable `$executeRawUnsafe(...DROP
  SCHEMA...)` — and it must index off the STATEMENT, not the string `DROP SCHEMA IF EXISTS`,
  whose first occurrence is in the docblock above it. (That mistake made the guard red on
  its first run.)
- **Missing checkout is reported DISTINCTLY from drift** — "I could not look" and "they
  diverged" are different failures with different fixes.

Proven by mutation, not by having been red: `MAX_PG_IDENTIFIER_BYTES` 63 → 62 in ONE copy
fails two of the five tests and prints the diverging line.

Deliberately NOT done: baking the repo into `LANE_SCHEMA_PREFIX`. It would force renaming
all fourteen lane names in the same commit (`dbos_e2e_api_api_render` otherwise) for no
safety gain.
