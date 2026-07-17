---
name: composition-source-of-truth-in-repo
description: No Composition/Scene tables in Postgres — composition lives in a Zod-validated supagloo.project.json manifest in the project's GitHub repo; generated media goes to S3
metadata:
  type: decision
---

Decided 2026-07-17 in `docs/design-delta.md` (§2): Postgres stores only
metadata/pointers/jobs. The Remotion composition (scenes, script text, visual
prompts, narrator voice, music bed, end card, captions) is serialized as a
`supagloo.project.json` manifest at the repo root, validated by
`ProjectManifestSchema` (Zod, in `supagloo-database-lib`) and versioned via
the project's `vX.Y.Z` git branches. Generated binary assets (scene
images/clips, narration, music, rendered videos) go to S3, referenced from
the manifest by key — NOT committed to git.

**Why:** wireframe 10a explicitly promises "Projects live in your GitHub
repos… Nothing is stored on our servers"; git handles version-branch
semantics for free; GitHub's 100 MB file limit and repo bloat rule out
committing media.

**Trade-offs:** S3-hosted media softens the "nothing on our servers" claim
(flagged as open question Q4 for user sign-off); manifest reads go through
the GitHub contents API rather than a fast local DB query.

Related: [[dbos-static-workflows-and-enqueue-pattern]]
