---
name: the-manifest-has-five-mirrors-not-four
description: The four-mirror rule for manifest fields is one short — the api's manifest DTO validation is a fifth strip point, and it is the one no repo's tests would catch
metadata:
  type: constraint
---

Every new `supagloo.project.json` field is walked through **four** mirrors (see
[[genesis1-inspector-model-cost-video-built]], [[render-bugs-narration-music-kenburns-built]]):

1. `db-lib/src/schemas.ts` `ProjectManifestSchema`
2. `dbos/src/remotion/manifest-json.ts` `canonicalizeManifest` — symmetrically
3. `nextjs/lib/api/contracts.ts` `ProjectManifestSchema`
4. `nextjs/lib/studio/manifest-adapter.ts`, BOTH directions (+ `Storyboard`/`Scene`)

**There is a fifth, and the rule does not name it: the api's manifest DTO validation.**
Found 2026-07-28 reviewing the genesis-1 `aiSettings` work.

The api does not forward the manifest it was given. It parses it with db-lib's
`ProjectManifestSchema` — a plain `z.object`, so Zod **strips unknown keys** — and then
forwards *its own parse output*:

- `api/src/jobs/project-jobs-service.ts:421` `safeParse(req.manifest)` → `:462` enqueues
  `parsedManifest.data`. **Every commit.**
- `api/src/manifests/manifest-service.ts:102` returns `parsed.data`. **Every read.**

So a field present in all four named mirrors is still silently erased in both directions
until the api's db-lib gitlink moves. `aiSettings` shipped in exactly that state: written
by the studio, mirrored four ways, and never once persisted.

**Why no test catches it.** Each repo's suites build manifest fixtures from the same schema
that does the stripping, so the field is absent from the fixture and absent from the result
— agreement, not proof. The only test that can see it is a real-lane e2e that commits and
re-opens (`E-MC5` for `aiSettings`), and that lane is structurally incapable of running
before the bump.

**Consequences to carry:**

- Walk **five** mirrors, and treat "the api validates the DTO" as a strip point, not a
  pass-through.
- A manifest field's release is **not** done when db-lib ships. The **api's gitlink must
  move too**, not only dbos's — the api is a manifest *processor*, which is easy to forget
  because it owns no manifest logic of its own.
- When a manifest feature looks built but does not persist, check this before debugging the
  studio or the workflow. The symptom is silent and total: no error, no partial write.

Related: [[in-flight-dblib-e2e-constraint]] (why the gitlink lags at all),
[[composition-source-of-truth-in-repo]] (why the manifest is the source of truth),
[[a-lane-that-builds-its-own-inputs-cannot-prove-the-producer]] (the same shape of
green-lie: a test whose fixture comes from the code under test).
