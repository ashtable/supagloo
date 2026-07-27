/**
 * PLAN ROW 45 (§9-Q8) — the PURE half of the render load harness.
 *
 * D45.1 makes the harness a standalone `npm run load:render` script rather than a vitest
 * spec: a load run occupies the shared Compose `render` queue and the `dbos` container for
 * minutes, so it must gate no suite. The row's Unit column ("Harness utilities — config
 * parsing, result summarization") is discharged HERE, by a module with no I/O and no
 * imports of its own, driven by `tests/unit/render-load-harness.test.ts`.
 * `scripts/render-load.mjs` is the runner that supplies the I/O.
 *
 * THREE exports are not conveniences — they are the row's proofs:
 *
 *   * {@link assertRenderQueueSerialFromImage} is D45.2(a). "Confirm concurrency 1/worker"
 *     is an assertion about configuration that ALREADY EXISTS (`render: { workerConcurrency:
 *     1 }`, flagged "firm"), and the memory
 *     `no-long-running-samplers-to-prove-a-precondition` forbids establishing it by
 *     watching `docker stats` on a timer. It reads the compiled registry OUT OF THE BUILT
 *     IMAGE ({@link DBOS_REGISTRY_PROBE}), before a single render is enqueued. R45-2: a host
 *     source read cannot do this job, because `docker-compose.override.yml` decides which
 *     tree the image was built from. {@link assertRenderQueueSerial} survives as an
 *     explicitly SECONDARY drift check over a checkout, and claims nothing more.
 *   * {@link assertRendersRanSerially} is D45.2(b), corrected by R45-3. The serialization
 *     claim is gated on {@link maxIntervalOverlap} — an exact sweep over the rows' own
 *     execution intervals — NOT on `overlapRatio`, which is a utilization figure that
 *     scored 0.0588 on a sample containing a complete overlap.
 *   * {@link assertNoProviderSpend} is brief §10 R8, and it is THE cost gate. A track costs
 *     money only when the manifest carries no cached ref AND the worker has a fallback
 *     model configured, so there are two independent ways to be free. An earlier
 *     `assertCachedAudioRefs` checked only the manifest half, was never wired into the
 *     runner, and was deleted in Step 11 (R45-6 / D5) rather than left as a documented
 *     proof nothing reached.
 */

/** D45.3 — the minimum N whose timeline can show that render 2 waited for render 1. */
export const DEFAULT_RENDER_COUNT = 2;

/**
 * The DBOS system schema the harness enqueues into. Deliberately the SDK default and NOT
 * a `dbos_e2e_*` lane schema — the inverse of every e2e lane in this project (brief §10
 * R5). The whole point of the harness is that the CONTAINERISED worker does the rendering,
 * and the container polls `dbos`. Enqueue into a lane schema and the harness waits forever
 * with no error anywhere.
 */
export const DEFAULT_SYSTEM_SCHEMA = "dbos";

const LANE_SCHEMA_PREFIX = "dbos_e2e_";

/** The Compose-published dev DSNs, matching `.env.example` and `tests/support/dev-config.ts`. */
export const DEV_APP_DATABASE_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo";
export const DEV_SYSTEM_DATABASE_URL =
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";

const KNOWN_FLAGS = new Set([
  "--count",
  "--render-job",
  "--dry-run",
  "--cleanup",
  "--poll-seconds",
  "--deadline-seconds",
]);

/**
 * R45-7. Flags that are switches, not settings. A VALUE on one of these was silently
 * inverting the operator's intent: `--dry-run=1` tokenizes to the string `"1"`, which
 * `=== true` rejected, so the harness enqueued N REAL renders for someone who asked for a
 * dry run. `--dry-run false` was worse — it reads as a disable and enqueued.
 */
const VALUELESS_FLAGS = new Set(["--dry-run", "--cleanup"]);

/** R45-7. Flags whose whole purpose is their value; a bare one used to mean "pick for me". */
const VALUED_FLAGS = new Map([
  ["--render-job", "a RenderJob id"],
  ["--count", "a positive integer"],
  ["--poll-seconds", "a positive integer"],
  ["--deadline-seconds", "a positive integer"],
]);

/** `["--a", "1", "--b=2", "--flag"]` -> `{ "--a": "1", "--b": "2", "--flag": true }`. */
function tokenize(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(
        `render-load: unexpected positional argument "${token}". Every option is a --flag.`,
      );
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!KNOWN_FLAGS.has(name)) {
      throw new Error(
        `render-load: unknown option "${name}". Known options: ${[...KNOWN_FLAGS].join(", ")}.`,
      );
    }
    if (eq !== -1) {
      out.set(name, token.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out.set(name, true);
      continue;
    }
    out.set(name, next);
    i += 1;
  }
  return out;
}

function positiveInteger(raw, flag) {
  const text = typeof raw === "string" ? raw.trim() : "";
  // Deliberately not Number(): Number("") is 0 and Number(" 3 ") is 3, both of which
  // would let a typo through as a plausible-looking value.
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `render-load: ${flag} must be a positive integer, got ${JSON.stringify(raw)}.`,
    );
  }
  const value = Number(text);
  if (value < 1) {
    throw new Error(`render-load: ${flag} must be at least 1, got ${value}.`);
  }
  return value;
}

/**
 * R45-7. Every flag is either a switch or a setting, and the harness's contract is to
 * THROW rather than default around anything that would make the run silently meaningless.
 * Both halves of this were violated in opposite directions before Step 11.
 */
function assertFlagArity(flags) {
  for (const [name, value] of flags) {
    if (VALUELESS_FLAGS.has(name) && value !== true) {
      throw new Error(
        `render-load: ${name} takes no value (got ${JSON.stringify(value)}). It is a ` +
          `switch: pass ${name} to turn it on and omit it to leave it off. A value used to ` +
          `read as OFF, which for --dry-run meant enqueueing real renders.`,
      );
    }
    if (value === true && VALUED_FLAGS.has(name)) {
      throw new Error(
        `render-load: ${name} requires ${VALUED_FLAGS.get(name)}. A bare ${name} used to ` +
          "fall through to automatic selection, i.e. to silently doing something else.",
      );
    }
  }
}

/**
 * Resolve the run configuration from argv + the environment. Throws — never defaults
 * around — on anything that would make the run silently meaningless.
 */
export function parseLoadConfig(argv = [], env = {}) {
  const flags = tokenize(argv);
  assertFlagArity(flags);

  const count = flags.has("--count")
    ? positiveInteger(flags.get("--count"), "--count")
    : DEFAULT_RENDER_COUNT;
  const pollSeconds = flags.has("--poll-seconds")
    ? positiveInteger(flags.get("--poll-seconds"), "--poll-seconds")
    : 5;
  const deadlineSeconds = flags.has("--deadline-seconds")
    ? positiveInteger(flags.get("--deadline-seconds"), "--deadline-seconds")
    : 1800;

  // Same fallback convention as `tests/support/dev-config.ts` and `.env.example`'s own
  // header: env var first, Compose's published dev DSN otherwise, so the harness runs
  // out-of-the-box against `docker compose up` without a root `.env` (which today carries
  // credentials only — the DSNs are never set in it). Not a silent default in the harmful
  // sense: a wrong database fails loudly at connect, and the resolved value is printed.
  const appDatabaseUrl = env.DATABASE_URL ?? DEV_APP_DATABASE_URL;
  const systemDatabaseUrl = env.DBOS_DATABASE_URL ?? DEV_SYSTEM_DATABASE_URL;

  // An inherited lane schema is the single most expensive mistake this harness can make:
  // the enqueue succeeds, the container never sees it, and the run burns its whole
  // deadline before saying anything. The api and dbos e2e lanes export this variable, so
  // inheriting a stale value from an interactive shell is a live risk, not a theoretical
  // one.
  const inherited = env.DBOS_SYSTEM_DATABASE_SCHEMA;
  if (inherited !== undefined && inherited !== DEFAULT_SYSTEM_SCHEMA) {
    throw new Error(
      `render-load: DBOS_SYSTEM_DATABASE_SCHEMA is set to "${inherited}". The harness must ` +
        `enqueue into the DEFAULT "${DEFAULT_SYSTEM_SCHEMA}" schema — that is the one the ` +
        `Compose dbos container polls. A ${LANE_SCHEMA_PREFIX}* schema would accept the ` +
        "enqueue and never be dequeued. Unset it and re-run.",
    );
  }

  return {
    count,
    pollSeconds,
    deadlineSeconds,
    appDatabaseUrl,
    systemDatabaseUrl,
    systemDatabaseSchema: DEFAULT_SYSTEM_SCHEMA,
    // Both are now safe to read positionally: `assertFlagArity` has already rejected a
    // valued `--dry-run`/`--cleanup` and a valueless `--render-job`, so a present flag
    // means exactly what it looks like.
    subjectRenderJobId: flags.has("--render-job") ? flags.get("--render-job") : null,
    dryRun: flags.has("--dry-run"),
    // R45-8 / D6 — OPT-IN, default OFF. Teardown deletes real rows and real MinIO objects
    // from state shared with dev and with four repos' e2e lanes; the residue is documented
    // as permanent by default (docs/render-sizing.md §5) precisely so nobody has to guess.
    cleanup: flags.has("--cleanup"),
  };
}

/**
 * SECONDARY, and explicitly labelled as such (R45-2). A drift check over a dbos SOURCE
 * checkout, asserting the `render` queue is still 1 workflow per worker THERE.
 *
 * It is NOT a statement about the running container, and the earlier comments that said
 * otherwise ("literally what the running container was built from") were unfounded:
 * `docker-compose.override.yml` is gitignored and can point the build context at either
 * the submodule or the sibling checkout, and Step 8's M13 confirmed the two DIFFER. The
 * structural proof is {@link assertRenderQueueSerialFromImage}, which reads the artifact.
 * This one only answers "does the checkout in front of me disagree with the image?".
 *
 * Comment lines are stripped FIRST. The registry's prose discusses the number at length,
 * and a guard that grepped the whole file would stay green after someone changed the code
 * and left the comment — the exact "green lie" shape design-delta §11.5 names.
 */
export function assertRenderQueueSerial(registrySource) {
  const code = String(registrySource)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const match = /\brender:\s*\{\s*workerConcurrency:\s*(\d+)\s*\}/.exec(code);
  if (!match) {
    throw new Error(
      "render-load: no `render: { workerConcurrency: N }` entry found in the dbos " +
        "registry's QUEUE_CONFIG. Row 45 CONFIRMS that entry rather than creating it; if " +
        "it moved, this harness is measuring something else.",
    );
  }
  if (match[1] !== "1") {
    throw new Error(
      `render-load: QUEUE_CONFIG.render.workerConcurrency is ${match[1]}, not 1. The ` +
        "design fixes it at 1/worker (design-delta §9-Q8, registry.ts comment \"firm\") " +
        "because Chromium is CPU- and memory-heavy. Refusing to publish sizing numbers " +
        "measured against a different queue shape.",
    );
  }
  return true;
}

/**
 * SECONDARY (R45-2), like {@link assertRenderQueueSerial}: the render workflow + queue
 * names as a db-lib SOURCE checkout declares them, for drift-checking against the names the
 * running worker actually registered ({@link readWorkflowNamesFromImage}).
 *
 * They are a cross-repo contract with ONE authored home, and they are NOT what a reader
 * guesses: the workflow is registered as `"render"`, not `"renderWorkflow"`. An enqueue
 * under a wrong name is durably accepted and never dequeued — the harness would poll until
 * its deadline and report "0 completed", which reads as a product failure rather than as a
 * typo. So the literals this harness uses are checked against the source that defines them.
 */
export function readWorkflowNames(workflowsSource) {
  const code = String(workflowsSource);
  const workflowName = /RENDER_WORKFLOW_NAME\s*=\s*"([^"]+)"/.exec(code)?.[1];
  const queueName = /RENDER_QUEUE_NAME\s*=\s*"([^"]+)"/.exec(code)?.[1];
  if (!workflowName || !queueName) {
    throw new Error(
      "render-load: could not read RENDER_WORKFLOW_NAME / RENDER_QUEUE_NAME from db-lib's " +
        "src/workflows.ts. They are the names the harness enqueues under; refusing to guess.",
    );
  }
  return { workflowName, queueName };
}

/**
 * THE ACTUAL COST GATE — brief §10 R8, restated after measurement.
 *
 * R45-6 / D5: an earlier `assertCachedAudioRefs` checked only the manifest half of this
 * condition, was documented in this module's header as "the row's proof", was covered by
 * four unit tests — and was imported by nothing. It was DELETED in Step 11 rather than
 * flag-gated, because a documented, tested assertion that nothing reaches is worse than no
 * assertion: an auditor asking "is §10 R8 enforced?" finds it and stops.
 *
 * `ensureNarrationAudio` / `ensureMusicAudio` call `planAudioTrack({ manifest, modelId })`
 * and can only synthesize when BOTH a cached ref is absent AND a fallback model id is
 * configured (`render.ts:589-625`). So a track costs money only when both hold, and there
 * are two independent ways to be safe. Checking only the manifest, as this harness first
 * did, refuses runs that provably cannot spend anything.
 *
 * That distinction turned out to be load-bearing. MEASURED against the live fixtures:
 * `canonicalizeManifest` (dbos `src/remotion/manifest-json.ts`) writes `music.assetKey` but
 * DROPS `narratorVoice.assetKey`, so no manifest that has round-tripped through a commit
 * can ever carry a cached NARRATION ref — the design's "synthesize only if the manifest
 * lacks cached asset refs" (design-delta §7:1320-1322) is unreachable for narration today.
 * What keeps Compose free is the second arm: `RENDER_NARRATION_MODEL` and
 * `RENDER_MUSIC_MODEL` both ship UNSET, and an unset model means the render proceeds
 * without that track rather than paying for one. Recorded here rather than worked around
 * silently; the serializer gap is a dbos/db-lib defect, not a harness concern.
 *
 * `workerEnv` is the running worker's environment (one `docker inspect`, read once at the
 * point of use — not sampled).
 */
export function assertNoProviderSpend(manifest, workerEnv = {}) {
  const risks = [];
  const check = (track, ref, modelVar) => {
    const model = workerEnv[modelVar];
    if (!ref && typeof model === "string" && model.trim() !== "") {
      risks.push(
        `${track}: the manifest carries no cached ref AND the worker has ${modelVar}=` +
          `${model.trim()}, so every render would synthesize it through a live provider`,
      );
    }
  };
  check("narration", manifest?.narratorVoice?.assetKey, "RENDER_NARRATION_MODEL");
  check("music", manifest?.music?.assetKey, "RENDER_MUSIC_MODEL");
  if (risks.length > 0) {
    throw new Error(
      `render-load: this run would make REAL provider calls, N times over:\n  - ${risks.join(
        "\n  - ",
      )}\nEither pick a subject whose manifest carries the cached ref (--render-job <id>) ` +
        "or unset the model on the dbos service.",
    );
  }
  return true;
}

/**
 * D45.2(b) — the observational half. Over snapshots of `dbos.workflow_status` for this
 * run's own workflow ids, the largest number that were simultaneously PENDING.
 *
 * PENDING is DBOS's "a worker has picked this up and is executing it"; ENQUEUED is
 * "waiting in the queue". With `workerConcurrency: 1` and one worker, this must be 1.
 */
export function maxSimultaneousRunning(samples) {
  let max = 0;
  for (const snapshot of samples ?? []) {
    let running = 0;
    for (const row of snapshot ?? []) {
      if (String(row?.status).toUpperCase() === "PENDING") running += 1;
    }
    if (running > max) max = running;
  }
  return max;
}

function percentile(sortedSeconds, fraction) {
  if (sortedSeconds.length === 0) return null;
  const index = Math.min(
    sortedSeconds.length - 1,
    Math.floor(fraction * sortedSeconds.length),
  );
  return sortedSeconds[index];
}

/**
 * Summarize the RenderJob rows this run created.
 *
 * `overlapRatio` = Σ(individual durations) ÷ (last finish − first start). It is a
 * **UTILIZATION** figure and nothing more (R45-3): `> 1` does imply overlap, but `<= 1`
 * implies nothing at all, because idle time anywhere in the span masks arbitrary overlap
 * elsewhere. It is reported because utilization is useful — it is how §2's ~0.7 s/render
 * queue-dispatch latency was derived — and it must never again be read as a serialization
 * proof. `maxIntervalOverlap` is the exact statement, and
 * {@link assertRendersRanSerially} is the gate.
 */
export function summarizeLoadRun(jobs) {
  const rows = jobs ?? [];
  const terminalSeconds = [];
  let completed = 0;
  let failed = 0;
  let canceled = 0;
  let unfinished = 0;
  let firstStart = null;
  let lastFinish = null;

  for (const job of rows) {
    const started = job.startedAt ? new Date(job.startedAt).getTime() : null;
    const finished = job.completedAt ? new Date(job.completedAt).getTime() : null;
    if (job.status === "completed") completed += 1;
    else if (job.status === "failed") failed += 1;
    else if (job.status === "canceled") canceled += 1;
    else unfinished += 1;

    if (started !== null && (firstStart === null || started < firstStart)) {
      firstStart = started;
    }
    if (finished !== null && (lastFinish === null || finished > lastFinish)) {
      lastFinish = finished;
    }
    if (started !== null && finished !== null) {
      terminalSeconds.push((finished - started) / 1000);
    }
  }

  const sorted = [...terminalSeconds].sort((a, b) => a - b);
  const spanSeconds =
    firstStart !== null && lastFinish !== null ? (lastFinish - firstStart) / 1000 : null;
  const summed = terminalSeconds.reduce((a, b) => a + b, 0);

  return {
    total: rows.length,
    completed,
    failed,
    canceled,
    unfinished,
    durationsSeconds: terminalSeconds,
    p50Seconds: percentile(sorted, 0.5),
    maxSeconds: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    spanSeconds,
    overlapRatio: spanSeconds && spanSeconds > 0 ? summed / spanSeconds : null,
    maxIntervalOverlap: maxIntervalOverlap(rows),
  };
}

/**
 * D45.2(b), CORRECTED BY R45-3. The gate the "renders completed serially per worker"
 * claim actually rests on.
 *
 * The shipped inference was `overlapRatio <= 1 ⇒ no two renders overlapped`, which is
 * false: `overlapRatio` is utilization, and idle time anywhere in the span masks arbitrary
 * overlap elsewhere. Step 8's M12 ran the shipped summarizer on two FULLY overlapping
 * renders plus one 50 s later and got **0.0588** — read by the doc as "no two renders
 * overlapped" and printed by the runner as approaching "strictly serial".
 *
 * `maxIntervalOverlap === 1` is the exact statement, from the same rows, with no sampling.
 * A run that yields NO measurable interval is refused rather than certified: "0 overlaps
 * observed" reads as serial when it means "no row carried both timestamps", the same class
 * of green lie as a silent 0-byte peak RSS.
 */
export function assertRendersRanSerially(jobs) {
  const rows = jobs ?? [];
  const observed = maxIntervalOverlap(rows);
  if (observed === 0) {
    throw new Error(
      `render-load: no render interval could be measured across ${rows.length} row(s) — ` +
        "every row is missing startedAt or completedAt. Refusing to certify serialization " +
        "from an unmeasured run; a silent pass here would read as \"serial\".",
    );
  }
  if (observed > 1) {
    throw new Error(
      `render-load: ${observed} render execution intervals were open at the same instant. ` +
        "The design fixes the render queue at 1 workflow/worker, so these numbers were not " +
        "measured against a serial worker and must not be published as if they were. " +
        "(overlapRatio cannot see this: it is utilization — Σdurations ÷ span — and scores " +
        "0.0588 on a sample containing a complete overlap.)",
    );
  }
  return true;
}

/**
 * R45-4 — the subject candidate query, with the harness's OWN rows excluded.
 *
 * Every row the harness creates ends `completed`, and selection was "the 8 most recently
 * completed renders" with no exclusion — so after a couple of runs most of the eight slots
 * were the harness's own residue, all pointing at ONE project, and the deliberate 8-deep
 * fallback degraded to two or three distinct subjects.
 *
 * STEP 8 CORRECTION to the reviewer's stated trigger: `scripts/cleanup-e2e-repos.mjs`
 * **archives and never deletes**, and an archived repo is still cloneable and still serves
 * `GET /contents/` — so "cleanup archived the subject" is NOT how this bites. The real
 * triggers are repo DELETION, manifest drift (a subject whose committed manifest stops
 * satisfying `assertNoProviderSpend`), and pool degradation itself: eight slots holding
 * three projects means one bad subject can exhaust the fallback.
 *
 * The exclusion is gated on `$1` being absent because `--render-job <id>` is a deliberate
 * operator choice and `resolveSubjectCandidates`'s own error message promises it works —
 * including for a `render-load-` row, whose project/version are perfectly good subjects.
 *
 * `DISTINCT ON (rj."projectId")` makes eight candidates mean eight PROJECTS. Postgres
 * requires the DISTINCT ON expression to lead `ORDER BY`, so the newest-first ordering is
 * re-applied outside the subquery.
 */
export function buildSubjectCandidateQuery(limit = 8) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `render-load: candidate depth must be a positive integer, got ${JSON.stringify(limit)}. ` +
        "It is the only value interpolated into this query.",
    );
  }
  return `SELECT * FROM (
       SELECT DISTINCT ON (rj."projectId")
              rj.id            AS "renderJobId",
              rj."projectId"   AS "projectId",
              rj."versionId"   AS "versionId",
              rj."userId"      AS "userId",
              rj."completedAt" AS "completedAt",
              rj.width, rj.height, rj.fps, rj."aspectRatio", rj.codec,
              p."repoOwner"    AS "repoOwner",
              p."repoName"     AS "repoName",
              pv."branchName"  AS "branchName"
         FROM "RenderJob" rj
         JOIN "Project" p         ON p.id  = rj."projectId"
         JOIN "ProjectVersion" pv ON pv.id = rj."versionId"
        WHERE rj.status = 'completed'
          AND p."deletedAt" IS NULL
          AND ($1::text IS NOT NULL OR rj.id NOT LIKE 'render-load-%')
          AND ($1::text IS NULL OR rj.id = $1::text)
        ORDER BY rj."projectId", rj."completedAt" DESC NULLS LAST
     ) AS s
      ORDER BY s."completedAt" DESC NULLS LAST
      LIMIT ${limit}`;
}

/**
 * R45-3 — the number `overlapRatio` was being mistaken for: the largest number of render
 * execution intervals that were open at the same instant.
 *
 * A sweep over start/end events, ENDS BEFORE STARTS at a tie (a hand-off in the same
 * millisecond is serial, not an overlap). Exact, and derived from the rows the run already
 * has — no sampler, no timer, nothing that behaves differently on a slow machine
 * (memory: `no-long-running-samplers-to-prove-a-precondition`).
 */
export function maxIntervalOverlap(jobs) {
  const events = [];
  for (const job of jobs ?? []) {
    if (!job?.startedAt || !job?.completedAt) continue;
    events.push([new Date(job.startedAt).getTime(), 1]);
    events.push([new Date(job.completedAt).getTime(), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let max = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > max) max = current;
  }
  return max;
}

/**
 * R45-8 / D6 — every S3 object this run's renders produced, de-duplicated.
 *
 * The harness knows exactly what it created, which is why opt-in teardown is possible at
 * all. Row 42's janitor cannot reclaim any of it: it selects `status in (failed, canceled)`
 * at both `findMany` sites and these rows are `completed`.
 */
export function renderJobTeardownKeys(jobs) {
  const keys = new Set();
  for (const job of jobs ?? []) {
    for (const key of [job?.outputAssetKey, job?.thumbnailAssetKey]) {
      if (typeof key === "string" && key.trim() !== "") keys.add(key);
    }
  }
  return [...keys];
}

/**
 * R45-2 — how to read the RUNNING worker's configuration.
 *
 * `docker run --rm --entrypoint node supagloo-dbos:latest -e "…"`, printing the compiled
 * registry out of the image. This is the only read that is unconditionally about what the
 * container runs: the gitignored `docker-compose.override.yml` can point the build context
 * at either the submodule or the sibling checkout, so NO host source path can honestly
 * claim to be what the image was built from.
 */
export const DBOS_REGISTRY_PROBE = {
  image: "supagloo-dbos:latest",
  module: "/app/dist/dbos/registry.js",
  dockerArgs: [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    "supagloo-dbos:latest",
    "-e",
    "const r = require('/app/dist/dbos/registry.js');" +
      "console.log(JSON.stringify({ QUEUE_CONFIG: r.QUEUE_CONFIG," +
      " WORKFLOW_NAMES: r.WORKFLOW_NAMES, WORKFLOW_QUEUE: r.WORKFLOW_QUEUE }));",
  ],
};

/** D45.2(a), read out of the image. `registry` is {@link DBOS_REGISTRY_PROBE}'s JSON. */
export function assertRenderQueueSerialFromImage(registry) {
  const queues = registry?.QUEUE_CONFIG;
  if (queues === null || typeof queues !== "object") {
    throw new Error(
      "render-load: the dbos image printed no QUEUE_CONFIG. Row 45 CONFIRMS the render " +
        "queue's shape rather than creating it; refusing to publish sizing numbers " +
        "measured against a worker whose queue configuration could not be read.",
    );
  }
  const value = queues.render?.workerConcurrency;
  if (value === undefined) {
    throw new Error(
      "render-load: the running dbos worker has no `render` queue in QUEUE_CONFIG. If the " +
        "queue moved, this harness is measuring something else.",
    );
  }
  if (value !== 1) {
    throw new Error(
      `render-load: the running worker's QUEUE_CONFIG.render.workerConcurrency is ${value}, ` +
        'not 1. The design fixes it at 1/worker (design-delta §9-Q8, registry.ts "firm") ' +
        "because Chromium is CPU- and memory-heavy. Refusing to publish sizing numbers " +
        "measured against a different queue shape.",
    );
  }
  return true;
}

/**
 * The render workflow + queue names as the RUNNING worker registered them.
 *
 * They are a cross-repo contract and they are NOT what a reader guesses: the workflow is
 * registered as `"render"`, not `"renderWorkflow"`. An enqueue under a wrong name is
 * durably accepted and never dequeued — the harness would poll to its deadline and report
 * "0 completed", which reads as a product failure rather than as a typo.
 */
export function readWorkflowNamesFromImage(registry) {
  const workflowName = registry?.WORKFLOW_NAMES?.render;
  if (typeof workflowName !== "string" || workflowName === "") {
    throw new Error(
      "render-load: the running dbos worker's WORKFLOW_NAMES has no `render` entry. " +
        "Refusing to guess the name to enqueue under.",
    );
  }
  const queueName = registry?.WORKFLOW_QUEUE?.render;
  if (typeof queueName !== "string" || queueName === "") {
    throw new Error(
      "render-load: the running dbos worker's WORKFLOW_QUEUE has no `render` entry. " +
        "Refusing to guess the queue to enqueue onto.",
    );
  }
  return { workflowName, queueName };
}

const UNIT_BYTES = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
};

function toBytes(text) {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  if (!m) return null;
  const unit = UNIT_BYTES[m[2].toUpperCase()];
  if (unit === undefined) return null;
  return Number(m[1]) * unit;
}

/**
 * One row of `docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"`.
 *
 * Throws rather than returning zeros on an unparseable row: a 0-byte peak in the sizing
 * doc reads as "this workload needs no memory" when it actually means "the sampler broke",
 * and the doc is the artifact people would size a production container from.
 */
export function parseDockerStatsRow(line) {
  const parts = String(line).split("|");
  if (parts.length < 4) {
    throw new Error(`render-load: unparseable docker stats row: ${JSON.stringify(line)}`);
  }
  const [name, cpu, mem, memPerc] = parts;
  const [used, limit] = mem.split("/");
  const memBytes = used === undefined ? null : toBytes(used);
  const limitBytes = limit === undefined ? null : toBytes(limit);
  const cpuPercent = Number(String(cpu).replace("%", ""));
  const memPercent = Number(String(memPerc).replace("%", ""));
  if (
    memBytes === null ||
    limitBytes === null ||
    !Number.isFinite(cpuPercent) ||
    !Number.isFinite(memPercent)
  ) {
    throw new Error(`render-load: unparseable docker stats row: ${JSON.stringify(line)}`);
  }
  return { name, cpuPercent, memBytes, limitBytes, memPercent };
}

/**
 * Peak/mean over the samples taken DURING the run — bounded by the run's own duration, and
 * used only to REPORT the memory profile. It proves nothing on its own; the serialization
 * claim comes from {@link assertRenderQueueSerial} and the rows' timestamps.
 */
export function summarizeMemorySamples(samples) {
  const rows = samples ?? [];
  if (rows.length === 0) {
    return {
      samples: 0,
      peakBytes: null,
      meanBytes: null,
      peakPercentOfLimit: null,
      peakCpuPercent: null,
      limitBytes: null,
    };
  }
  const peakBytes = Math.max(...rows.map((r) => r.memBytes));
  const meanBytes = rows.reduce((a, r) => a + r.memBytes, 0) / rows.length;
  const limitBytes = rows[rows.length - 1].limitBytes ?? null;
  return {
    samples: rows.length,
    peakBytes,
    meanBytes,
    peakPercentOfLimit: limitBytes ? (peakBytes / limitBytes) * 100 : null,
    peakCpuPercent: Math.max(...rows.map((r) => r.cpuPercent ?? 0)),
    limitBytes,
  };
}
