#!/usr/bin/env node
/**
 * PLAN ROW 45 (§9-Q8) — THE RENDER LOAD HARNESS.  `npm run load:render`
 *
 * "Repeatable load harness for the `render` queue — worker memory profile, `renderMedia`
 * timeout tuning, confirm concurrency 1/worker; document Railway sizing recommendation in
 * `docs/`." The findings this produces go into `docs/render-sizing.md`.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT A VITEST SPEC (D45.1)
 * ---------------------------------------------------------------------------------------
 * (i) The row's E2E column says "Load runs against Compose", not "a lane".
 * (ii) A new dbos spec would cost a 15th lane schema AND would have to run against a
 *      `dbos_e2e_*` schema — which the containerised worker never polls, so the work would
 *      sit enqueued forever. The harness must use the DEFAULT `dbos` schema, the exact
 *      inverse of every e2e lane in this project (brief §10 R5).
 * (iii) A load run occupies the shared `render` queue and the `dbos` container for minutes.
 *      A script gates no suite, so a slow run can never turn the gating suite red.
 * Its decidable parts live in `scripts/render-load-harness.mjs` and are unit-tested by
 * `tests/unit/render-load-harness.test.ts` — that is the row's Unit column.
 *
 * ---------------------------------------------------------------------------------------
 * WHY IT RENDERS AN EXISTING SUBJECT RATHER THAN CREATING ONE
 * ---------------------------------------------------------------------------------------
 * A render subject is a real repo on real github.com carrying a pushed Remotion scaffold, a
 * `Project`/`ProjectVersion` pair, a `GithubConnection` for its owner, and the manifest's
 * assets in MinIO. The dbos render lane builds exactly that, per run, and leaves it behind
 * (there is no in-suite teardown, by design — design-delta §11.3:2088-2093). Re-rendering
 * one is safe in a way re-scaffolding is not: render only ever CLONES the repo, whereas
 * `createUserRepo` is non-idempotent and a scaffold's v0.0.0 commit is byte-deterministic,
 * so a reused fixture repo rejects a second scaffold (brief §10 R7). So the harness
 * consumes a subject instead of minting one: no new throwaway repos, no `POST /user/repos`,
 * and N is bounded by minutes rather than by GitHub's secondary rate limits.
 *
 * The subject is VERIFIED, not assumed: its manifest is fetched from the repo through the
 * product's own installation-token path and must carry cached narration AND music asset
 * refs, or the harness refuses to run. Without them each render synthesizes audio through a
 * live provider, so N renders would be N real provider calls (brief §10 R8 / D45.3).
 *
 * ---------------------------------------------------------------------------------------
 * WHAT IT PROVES, AND HOW (D45.2)
 * ---------------------------------------------------------------------------------------
 *  - "concurrency 1/worker" — STRUCTURALLY, by reading the compiled `QUEUE_CONFIG` OUT OF
 *    THE BUILT `supagloo-dbos:latest` IMAGE before enqueueing anything, and then
 *    OBSERVATIONALLY, from the workflow rows' own timestamps and from snapshots of
 *    `dbos.workflow_status`. Never by watching `docker stats` on a timer and inferring it
 *    (memory: `no-long-running-samplers-to-prove-a-precondition`). `docker stats` is used
 *    ONLY to report the memory profile, bounded to the run's own duration.
 *  - the memory profile — peak/mean RSS of the `dbos` container across the run.
 *  - "without OOM/timeout" — every enqueued RenderJob reaches `completed`.
 *
 * R45-2, and the reason the structural half reads an artifact rather than a file: this
 * script used to read `~/code/supagloo-nodejs-dbos` while `docker-compose.yml` builds
 * `./supagloo-nodejs-dbos` (the submodule), and Step 8's M13 confirmed the two DIFFERED —
 * the submodule had no `media-options.ts` at all. The gitignored
 * `docker-compose.override.yml` can point the build context at either tree, so neither path
 * can honestly be called "what the container was built from". The image can.
 *
 * Usage:
 *   npm run load:render                          # N = 2
 *   npm run load:render -- --count 4
 *   npm run load:render -- --render-job <id>     # pin the subject
 *   npm run load:render -- --dry-run             # resolve + verify, enqueue nothing
 *   npm run load:render -- --cleanup             # OPT-IN teardown; see docs §5
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";

import {
  discoverInstallation,
  githubFetch,
  loadRootEnv,
  mintInstallationTokenLocal,
  resolveGithubE2eSecrets,
} from "../tests/support/e2e-github-api.mjs";
import {
  DBOS_REGISTRY_PROBE,
  assertNoProviderSpend,
  assertRenderQueueSerialFromImage,
  assertRendersRanSerially,
  buildSubjectCandidateQuery,
  maxSimultaneousRunning,
  parseDockerStatsRow,
  parseLoadConfig,
  readWorkflowNamesFromImage,
  renderJobTeardownKeys,
  summarizeLoadRun,
  summarizeMemorySamples,
} from "./render-load-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DBOS_CONTAINER = "supagloo-dbos-1";

/** The Compose-published dev MinIO endpoint + credentials, used only by `--cleanup`. */
const DEV_S3 = {
  endpoint: "http://localhost:9000",
  bucket: "supagloo-dev",
  accessKeyId: "supagloo",
  secretAccessKey: "supagloo-dev",
  region: "us-east-1",
};

/** The manifest's canonical path inside every project repo (dbos `src/remotion/generate.ts`). */
const MANIFEST_PATH = "supagloo.project.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(...args);
}

/* ------------------------------------------------------------------ subject lookup */

/**
 * A render subject: a project whose repo really holds a scaffolded Remotion project and
 * whose version really rendered once before. Picked by "most recently completed render",
 * because that is the strongest available evidence that the whole chain still works — one
 * per PROJECT, and never one of the harness's own rows (R45-4; the SQL and the reasoning
 * live in `buildSubjectCandidateQuery`, which is unit-tested).
 */
async function resolveSubjectCandidates(db, explicitRenderJobId) {
  const { rows } = await db.query(buildSubjectCandidateQuery(), [
    explicitRenderJobId ?? null,
  ]);
  if (rows.length === 0) {
    // LOUD, never a silent skip. A harness that quietly did nothing would put "no findings"
    // in a sizing document, which is worse than no document.
    throw new Error(
      explicitRenderJobId
        ? `render-load: no completed RenderJob with id ${explicitRenderJobId}.`
        : "render-load: found no completed RenderJob to use as a subject. Run the dbos " +
          "render e2e lane first (`npm run test:e2e -- render.render` in " +
          "supagloo-nodejs-dbos); it leaves a real fixture repo + project behind, which is " +
          "exactly what this harness re-renders.",
    );
  }
  return rows;
}

/**
 * The running worker's own environment, read ONCE (one `docker inspect`, no polling). It is
 * what decides whether an absent cached audio ref actually costs money — see
 * `assertNoProviderSpend`.
 */
function readWorkerEnv() {
  const r = spawnSync(
    "docker",
    ["inspect", DBOS_CONTAINER, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `render-load: could not inspect the ${DBOS_CONTAINER} container. The harness needs ` +
        "the Compose stack up — it is the containerised worker that performs the renders.",
    );
  }
  const env = {};
  for (const line of (r.stdout ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/** Fetch the subject's manifest from real github.com through the product's token path. */
async function fetchSubjectManifest(subject) {
  const secrets = resolveGithubE2eSecrets();
  const installation = await discoverInstallation({
    appId: secrets.appId,
    appSlug: secrets.appSlug,
    privateKey: secrets.privateKey,
  });
  const token = await mintInstallationTokenLocal({
    appId: secrets.appId,
    privateKey: secrets.privateKey,
    installationId: installation.installationId ?? installation.id,
  });
  const res = await githubFetch(
    `https://api.github.com/repos/${subject.repoOwner}/${subject.repoName}/contents/` +
      `${MANIFEST_PATH}?ref=${encodeURIComponent(subject.branchName)}`,
    { token, label: `read ${MANIFEST_PATH}` },
  );
  const encoded = res.body?.content;
  if (typeof encoded !== "string") {
    throw new Error(
      `render-load: ${subject.repoOwner}/${subject.repoName}@${subject.branchName} has no ` +
        `${MANIFEST_PATH}. The repo may have been DELETED, or the branch may have moved. ` +
        "(It is not `npm run cleanup:github-e2e`: that script ARCHIVES and never deletes, " +
        "and an archived repo still clones and still serves GET /contents/ — verified.) " +
        "Pick another subject with --render-job.",
    );
  }
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

/* ------------------------------------------------------------- running configuration */

/**
 * D45.2(a) — the STRUCTURAL half, read out of the artifact the container actually runs.
 *
 * One `docker run`, no polling, no timer. See {@link DBOS_REGISTRY_PROBE} and the R45-2
 * note in this file's header for why a host source read cannot answer this question.
 */
function readRunningRegistry() {
  const r = spawnSync("docker", DBOS_REGISTRY_PROBE.dockerArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `render-load: could not read ${DBOS_REGISTRY_PROBE.module} out of ` +
        `${DBOS_REGISTRY_PROBE.image}. That image is what the Compose \`dbos\` service runs, ` +
        "so its queue configuration is the only one these numbers can honestly be about. " +
        `Build it first (\`docker compose build dbos\`).\n${(r.stderr ?? "").trim()}`,
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `render-load: ${DBOS_REGISTRY_PROBE.image} printed something that is not JSON:\n` +
        `${(r.stdout ?? "").trim().slice(0, 400)}`,
    );
  }
}

/* ---------------------------------------------------------------------- sampling */

/** One bounded `docker stats --no-stream` reading of the dbos container. Never throws the
 *  run away: a failed sample is reported as a gap, not as a zero. */
function sampleContainer() {
  const r = spawnSync(
    "docker",
    [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}",
      DBOS_CONTAINER,
    ],
    { encoding: "utf8" },
  );
  const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  try {
    return parseDockerStatsRow(line);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- teardown */

/**
 * R45-8 / D6 — OPT-IN self-teardown (`--cleanup`), DEFAULT OFF.
 *
 * Row 42's `cleanupOrphanedAssetsWorkflow` selects `status in (failed, canceled)` at both
 * of its `findMany` sites, so the harness's `completed` rows and their `2N` MinIO objects
 * are permanently outside its delete set. That is structural, not a backlog — hence this,
 * and hence the doc saying so plainly.
 *
 * It is OFF by default because the app database and the single `supagloo-dev` bucket are
 * SHARED with dev and with fifteen e2e lanes in four repos: a default-on delete is a
 * destructive action taken on someone else's state without being asked. Everything below is
 * scoped to ids this process created and to asset keys those rows themselves report.
 *
 * NOT reclaimed, deliberately: the DBOS `workflow_status` / `operation_outputs` rows in the
 * default `dbos` schema. Deleting checkpoint rows out from under a running worker is not a
 * supported operation and there is no SDK call for it; they are small, bounded by N, and
 * `docs/render-sizing.md` §5 states that they stay.
 */
async function teardown(db, jobs, createdIds) {
  if (createdIds.length === 0) return;
  const keys = renderJobTeardownKeys(jobs);
  log(`\n--cleanup: removing ${createdIds.length} row(s) and ${keys.length} object(s)`);

  if (keys.length > 0) {
    const s3 = new S3Client({
      endpoint: DEV_S3.endpoint,
      region: DEV_S3.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: DEV_S3.accessKeyId,
        secretAccessKey: DEV_S3.secretAccessKey,
      },
    });
    try {
      const res = await s3.send(
        new DeleteObjectsCommand({
          Bucket: DEV_S3.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false },
        }),
      );
      log(`  · deleted ${res.Deleted?.length ?? 0} object(s) from ${DEV_S3.bucket}`);
      // Reported, never swallowed: a partial delete leaves residue the doc says is gone.
      for (const e of res.Errors ?? []) {
        process.exitCode = 1;
        log(`  ✗ ${e.Key}: ${e.Code} ${e.Message}`);
      }
    } finally {
      s3.destroy();
    }
  }

  // Deliberately keyed to `= ANY($1)` on ids this process minted, NOT to a
  // `LIKE 'render-load-%'` sweep: a concurrent run's rows are not this run's to delete.
  const { rowCount } = await db.query(`DELETE FROM "RenderJob" WHERE id = ANY($1::text[])`, [
    createdIds,
  ]);
  log(`  · deleted ${rowCount} RenderJob row(s)`);
  log(
    "  · KEPT: the DBOS workflow_status/operation_outputs rows in the default `dbos` " +
      "schema (no supported way to delete a worker's checkpoints; see docs §5)",
  );
}

/* -------------------------------------------------------------------------- main */

async function main() {
  loadRootEnv();
  const config = parseLoadConfig(process.argv.slice(2), process.env);

  // D45.2(a) — the STRUCTURAL half, checked before anything is enqueued. Sizing numbers
  // measured against a differently-shaped queue would be worse than no numbers. Read from
  // the IMAGE, which is the only artifact that is unambiguously what the worker runs
  // (R45-2).
  const registry = readRunningRegistry();
  assertRenderQueueSerialFromImage(registry);
  log(
    `✓ QUEUE_CONFIG.render.workerConcurrency === 1 (read from ${DBOS_REGISTRY_PROBE.image}` +
      `:${DBOS_REGISTRY_PROBE.module})`,
  );

  // The names are a cross-repo contract with one authored home in db-lib, and the
  // workflow's is `"render"` — NOT `"renderWorkflow"`. Taken from the same artifact read, so
  // they are the names the running worker REGISTERED rather than the names some checkout
  // declares.
  const { workflowName, queueName } = readWorkflowNamesFromImage(registry);
  log(`✓ enqueue target: workflow "${workflowName}" on queue "${queueName}"`);

  const db = new pg.Client({ connectionString: config.appDatabaseUrl });
  await db.connect();

  let client;
  const createdIds = [];
  try {
    // Try the most recent completed renders in order and take the first whose manifest
    // actually carries cached audio refs. The dbos render lane deliberately leaves BOTH
    // shapes behind — its `render-synth` subject has NO narration ref precisely so that
    // spec exercises live synthesis — and that one is usually the newest. Rejecting it and
    // moving on is the difference between "the harness refuses to run" and "the harness
    // silently spends money", and the rejections are printed rather than swallowed.
    const workerEnv = readWorkerEnv();
    const candidates = await resolveSubjectCandidates(db, config.subjectRenderJobId);
    let subject;
    const rejected = [];
    for (const candidate of candidates) {
      let manifest;
      try {
        manifest = await fetchSubjectManifest(candidate);
        assertNoProviderSpend(manifest, workerEnv);
      } catch (err) {
        rejected.push(
          `  - ${candidate.repoOwner}/${candidate.repoName}: ` +
            `${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        );
        continue;
      }
      subject = candidate;
      break;
    }
    if (!subject) {
      throw new Error(
        "render-load: no usable render subject. Every candidate was rejected — either its " +
          "repo is gone / its manifest drifted, or rendering it would make real provider " +
          `calls, ${config.count} time(s) over:\n${rejected.join("\n")}`,
      );
    }
    for (const line of rejected) log(`· skipped${line.slice(1)}`);
    log(
      `✓ subject: ${subject.repoOwner}/${subject.repoName}@${subject.branchName} ` +
        `(project ${subject.projectId}, version ${subject.versionId})`,
    );
    log(
      "✓ no provider spend possible: every audio track is either a cached manifest ref or " +
        "has no fallback model configured on the worker",
    );

    const runId = randomUUID().slice(0, 8);
    const ids = Array.from({ length: config.count }, (_, i) => `render-load-${runId}-${i + 1}`);

    if (config.dryRun) {
      log(`\nDRY RUN — would enqueue ${config.count} render(s): ${ids.join(", ")}`);
      return;
    }

    for (const id of ids) {
      await db.query(
        `INSERT INTO "RenderJob"
           (id, "projectId", "versionId", "userId", status, "framesDone", "framesTotal",
            width, height, fps, "aspectRatio", codec, "runInBackground", "createdAt")
         VALUES ($1,$2,$3,$4,'queued',0,0,$5,$6,$7,$8,$9,true, now())`,
        [
          id,
          subject.projectId,
          subject.versionId,
          subject.userId,
          subject.width,
          subject.height,
          subject.fps,
          subject.aspectRatio,
          subject.codec,
        ],
      );
      createdIds.push(id);
    }
    log(`✓ seeded ${createdIds.length} queued RenderJob row(s)`);

    // The DEFAULT schema, deliberately (brief §10 R5). No `appVersion` either: DBOS's
    // dequeue predicate accepts NULL, so the running container picks these up regardless of
    // which image version it is on. Pinning a version here would be a way to enqueue work
    // nothing ever dequeues.
    client = await DBOSClient.create({
      systemDatabaseUrl: config.systemDatabaseUrl,
      systemDatabaseSchemaName: config.systemDatabaseSchema,
    });
    for (const id of createdIds) {
      await client.enqueue(
        {
          workflowName,
          queueName,
          workflowID: id,
        },
        { renderJobId: id },
      );
    }
    log(
      `✓ enqueued ${createdIds.length} workflow(s) on queue "${queueName}" ` +
        `in schema "${config.systemDatabaseSchema}"\n`,
    );

    const sys = new pg.Client({ connectionString: config.systemDatabaseUrl });
    await sys.connect();

    const statusSamples = [];
    const memorySamples = [];
    const deadline = Date.now() + config.deadlineSeconds * 1000;
    let jobs = [];
    try {
      while (Date.now() < deadline) {
        const { rows } = await db.query(
          `SELECT id, status, "startedAt", "completedAt", "framesDone", "framesTotal", error,
                  "outputAssetKey", "thumbnailAssetKey"
             FROM "RenderJob" WHERE id = ANY($1::text[]) ORDER BY id`,
          [createdIds],
        );
        jobs = rows;

        const wf = await sys.query(
          `SELECT workflow_uuid AS "workflowUuid", status
             FROM ${config.systemDatabaseSchema}.workflow_status
            WHERE workflow_uuid = ANY($1::text[])`,
          [createdIds],
        );
        statusSamples.push(wf.rows);

        const mem = sampleContainer();
        if (mem) memorySamples.push(mem);

        const terminal = jobs.filter((j) =>
          ["completed", "failed", "canceled"].includes(j.status),
        ).length;
        log(
          `  [${new Date().toISOString().slice(11, 19)}] ` +
            jobs
              .map((j) => `${j.id.slice(-2)}=${j.status}(${j.framesDone}/${j.framesTotal})`)
              .join(" ") +
            (mem ? `  dbos rss=${(mem.memBytes / 1024 ** 2).toFixed(0)}MiB cpu=${mem.cpuPercent}%` : ""),
        );
        if (terminal === createdIds.length) break;
        await sleep(config.pollSeconds * 1000);
      }
    } finally {
      await sys.end().catch(() => {});
    }

    const summary = summarizeLoadRun(jobs);
    const memory = summarizeMemorySamples(memorySamples);
    const maxRunning = maxSimultaneousRunning(statusSamples);

    log("\n──────────────── render load run ────────────────");
    log(`renders            : ${summary.total} (completed ${summary.completed}, failed ${summary.failed}, unfinished ${summary.unfinished})`);
    log(`per-render seconds : ${summary.durationsSeconds.map((s) => s.toFixed(1)).join(", ") || "-"}`);
    log(`p50 / max seconds  : ${summary.p50Seconds?.toFixed(1) ?? "-"} / ${summary.maxSeconds?.toFixed(1) ?? "-"}`);
    log(`wall-clock span    : ${summary.spanSeconds?.toFixed(1) ?? "-"} s`);
    // R45-3. These two lines say DIFFERENT things and the first used to be printed as if it
    // said the second. `overlapRatio` is utilization (Σdurations ÷ span): `> 1` implies
    // overlap, `<= 1` implies NOTHING, because idle time masks overlap elsewhere.
    // `max concurrent renders` is the exact sweep over the rows' execution intervals.
    log(`utilization ratio  : ${summary.overlapRatio?.toFixed(3) ?? "-"}  (Σdurations ÷ span — NOT an overlap test)`);
    log(`max concurrent     : ${summary.maxIntervalOverlap}  (exact, from startedAt/completedAt — 1 = serial)`);
    log(`max simultaneous   : ${maxRunning}  (PENDING workflows in the polled snapshots)`);
    log(`dbos peak RSS      : ${memory.peakBytes !== null ? (memory.peakBytes / 1024 ** 2).toFixed(0) + " MiB" : "-"} of ${memory.limitBytes !== null ? (memory.limitBytes / 1024 ** 3).toFixed(2) + " GiB" : "-"} (${memory.peakPercentOfLimit?.toFixed(1) ?? "-"}%)`);
    log(`dbos mean RSS      : ${memory.meanBytes !== null ? (memory.meanBytes / 1024 ** 2).toFixed(0) + " MiB" : "-"} over ${memory.samples} samples`);
    log(`dbos peak CPU      : ${memory.peakCpuPercent ?? "-"} %`);
    log("─────────────────────────────────────────────────");
    log(JSON.stringify({ summary, memory, maxRunning, jobs }, null, 2));

    if (summary.completed !== summary.total) {
      process.exitCode = 1;
      log("\n✗ not every render completed — see the `error` column above.");
    }

    // D45.2(b), R45-3. The serialization claim, gated AFTER the numbers are printed so a
    // failure still leaves the operator the full picture — but loudly, and non-zero, so it
    // can never be quoted as "renders ran serially" on the strength of a ratio.
    try {
      assertRendersRanSerially(jobs);
      log("\n✓ serialization: at most 1 render interval was ever open at a time (exact)");
    } catch (err) {
      process.exitCode = 1;
      log(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    }

    if (config.cleanup) {
      await teardown(db, jobs, createdIds);
    } else if (createdIds.length > 0) {
      log(
        `\n· residue kept (default): ${createdIds.length} RenderJob row(s) ` +
          `render-load-${runId}-*, their DBOS workflow rows, and ` +
          `${renderJobTeardownKeys(jobs).length} MinIO object(s). Row 42's janitor will ` +
          "NEVER reclaim these — it selects failed/canceled jobs and these are completed. " +
          "Pass --cleanup to remove the rows and the objects (see docs/render-sizing.md §5).",
      );
    }
  } finally {
    await client?.destroy().catch(() => {});
    await db.end().catch(() => {});
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message.startsWith("render-load:") ? message : `render-load: ${message}`);
  process.exit(1);
});
