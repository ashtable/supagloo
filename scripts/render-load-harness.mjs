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
 * Two exports are not conveniences — they are the row's proofs:
 *
 *   * {@link assertRenderQueueSerial} is D45.2(a). "Confirm concurrency 1/worker" is an
 *     assertion about configuration that ALREADY EXISTS (`dbos/src/dbos/registry.ts`,
 *     `render: { workerConcurrency: 1 }`, flagged "firm"), and the memory
 *     `no-long-running-samplers-to-prove-a-precondition` forbids establishing it by
 *     watching `docker stats` on a timer. It is read out of the dbos checkout's source and
 *     checked INLINE, before a single render is enqueued.
 *   * {@link assertCachedAudioRefs} is brief §10 R8. `ensureNarrationAudio` /
 *     `ensureMusicAudio` synthesize only when the manifest lacks cached asset refs, so a
 *     subject without them turns N renders into N live OpenRouter TTS calls. Checked
 *     against the manifest actually committed in the subject's repo.
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
  "--poll-seconds",
  "--deadline-seconds",
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
 * Resolve the run configuration from argv + the environment. Throws — never defaults
 * around — on anything that would make the run silently meaningless.
 */
export function parseLoadConfig(argv = [], env = {}) {
  const flags = tokenize(argv);

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
    subjectRenderJobId:
      typeof flags.get("--render-job") === "string" ? flags.get("--render-job") : null,
    dryRun: flags.get("--dry-run") === true,
  };
}

/**
 * D45.2(a). Assert, from the dbos checkout's own source, that the `render` queue is still
 * 1 workflow per worker.
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
 * The render workflow + queue names, read out of db-lib's `src/workflows.ts` rather than
 * re-typed here.
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
 * brief §10 R8 / D45.3. A subject whose manifest carries cached narration AND music asset
 * refs makes N renders cost TIME, not provider money: `ensureNarrationAudio` /
 * `ensureMusicAudio` synthesize only when a ref is absent.
 */
export function assertCachedAudioRefs(manifest) {
  const missing = [];
  if (!manifest?.narratorVoice?.assetKey) missing.push("narratorVoice.assetKey");
  if (!manifest?.music?.assetKey) missing.push("music.assetKey");
  if (missing.length > 0) {
    throw new Error(
      `render-load: the subject manifest is missing ${missing.join(" and ")}. Without a ` +
        "cached ref the render SYNTHESIZES that track through a live provider on every " +
        "run, so N renders would be N real provider calls. Pick a subject whose manifest " +
        "carries both refs (--render-job <id>).",
    );
  }
  return true;
}

/**
 * THE ACTUAL COST GATE — brief §10 R8, restated after measurement.
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
 * `overlapRatio` = sum(individual durations) / (last finish − first start). Exactly 1.0
 * means no two renders overlapped by even a tick; > 1 means they did. It is the number the
 * sizing doc's "the renders ran strictly serially" claim rests on, and it is derived from
 * the rows' own timestamps rather than from anything sampled.
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
  };
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
