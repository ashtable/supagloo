---
name: dblib-build-chmod-bin
description: database-lib build must chmod +x the check-prisma-version bin because tsc strips the executable bit
metadata:
  type: gotcha
---

`supagloo-database-lib`'s `build` script must end with
`chmod +x dist/check-prisma-version.cli.js`. `tsc` emits the compiled bin as
`-rw-r--r--` (non-executable). That file is the package's `bin` target
(`"check-prisma-version"`), invoked by consumers' `postinstall`
(e.g. supagloo-nodejs-api `"postinstall": "check-prisma-version"`).

**Why it bites:** the local-dev workflow copies/rsyncs db-lib's `dist/` into a
consumer's nested submodule checkout (to test db-lib changes before publishing)
instead of a fresh `npm install`. When the consumer's `node_modules` already
exists, npm re-runs `postinstall` against the non-executable bin → "Permission
denied", exit 126, `npm install` fails. A fresh `npm install` wouldn't hit this
(npm sets the bit on link), so it only surfaces in the rsync-based local flow.

Fixed 2026-07-19 (task-13 Step 11) by appending `&& chmod +x dist/check-prisma-version.cli.js`
to `build`. Keep this on any future build-script refactor, and add an analogous
chmod for any new `bin` entry. Relates to [[prisma-exact-version-pin]] (the check
this bin performs) and [[s3-file-presign-service-built]] (task-13).
