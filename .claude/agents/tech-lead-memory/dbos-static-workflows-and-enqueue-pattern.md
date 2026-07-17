---
name: dbos-static-workflows-and-enqueue-pattern
description: Hard constraint — DBOS workflows are statically registered only (no dynamic registration); API enqueues via DBOSClient with workflowID = domain-record id
metadata:
  type: constraint
---

User-imposed hard constraint (2026-07-17, design-delta §7): the DBOS layer
(`supagloo-nodejs-dbos`) uses ONLY statically-registered workflows —
`DBOS.registerWorkflow(fn, { name })` / `@DBOS.workflow()` at module load,
before `DBOS.launch()`. No dynamic/runtime workflow registration, ever.
Variability (provider, model, scene, repo) flows through workflow arguments;
the API maps request kinds to workflow names via a static lookup table.
Bounded loops over statically-registered steps (e.g. LLM re-prompt on Zod
validation failure, max 3) are fine — they are not dynamic workflows.

Enqueue pattern: `supagloo-nodejs-api` does NOT run the DBOS runtime — it
uses `DBOSClient.enqueue` against the `supagloo_dbos` system database with
explicit `workflowName`/`queueName` and `workflowID` set to the domain-record
id (RenderJob / AiGeneration / ProjectJob id) for idempotent, exactly-once
submission. Status flows back via app-DB rows the workflows update (UI polls
the API); no HTTP between API and DBOS.

Queues: `git-ops` (~4/worker), `ai-generation` (~8/worker), `render`
(1/worker — Chromium/memory heavy).

Workflow inventory (design-delta §7): scaffoldProject, importProject,
commitVersion, publishVersion, generateScript, generateImage, generateAudio,
generateVideoClip, render, cleanupOrphanedAssets (scheduled).

Related: [[composition-source-of-truth-in-repo]]
