/**
 * Hand-written types for `scripts/render-load-harness.mjs`.
 *
 * Same convention as `tests/support/e2e-github-api.d.mts` and
 * `scripts/cleanup-e2e-repos.d.mts`: the harness itself is plain, zero-dependency,
 * build-free ESM so `npm run load:render` works without compiling anything, and its
 * consumers (only `scripts/render-load.mjs` and `tests/unit/render-load-harness.test.ts`)
 * get their types from here.
 */

export declare const DEFAULT_RENDER_COUNT: 2;
export declare const DEFAULT_SYSTEM_SCHEMA: "dbos";
export declare const DEV_APP_DATABASE_URL: string;
export declare const DEV_SYSTEM_DATABASE_URL: string;

export interface LoadConfig {
  count: number;
  pollSeconds: number;
  deadlineSeconds: number;
  appDatabaseUrl: string;
  systemDatabaseUrl: string;
  /** Always the DEFAULT `dbos` schema — the one the Compose worker polls (brief §10 R5). */
  systemDatabaseSchema: string;
  subjectRenderJobId: string | null;
  dryRun: boolean;
  /** R45-8 / D6 — `--cleanup`. OPT-IN self-teardown; default `false`. */
  cleanup: boolean;
}

export declare function parseLoadConfig(
  argv?: readonly string[],
  env?: Record<string, string | undefined>,
): LoadConfig;

/**
 * The compiled dbos registry as {@link DBOS_REGISTRY_PROBE} prints it out of the image.
 * Open-ended: it carries every queue and every workflow, and the harness reads `render`.
 */
export interface RunningRegistry {
  QUEUE_CONFIG?: Record<string, { workerConcurrency?: number } | undefined> | null;
  WORKFLOW_NAMES?: Record<string, string | undefined> | null;
  WORKFLOW_QUEUE?: Record<string, string | undefined> | null;
}

/**
 * R45-2 — the one-shot `docker run` that reads the RUNNING worker's configuration out of
 * the built image. `module` is a path INSIDE the image; a host path here would silently
 * turn the structural proof back into a claim about a file nothing was built from.
 */
export declare const DBOS_REGISTRY_PROBE: {
  image: string;
  module: string;
  dockerArgs: readonly string[];
};

export declare function assertRenderQueueSerialFromImage(
  registry: RunningRegistry | null | undefined,
): true;

export declare function readWorkflowNamesFromImage(
  registry: RunningRegistry | null | undefined,
): { workflowName: string; queueName: string };

/** SECONDARY drift check over a dbos SOURCE checkout — never a build-context claim. */
export declare function assertRenderQueueSerial(registrySource: string): true;

/** SECONDARY drift check over a db-lib SOURCE checkout. */
export declare function readWorkflowNames(workflowsSource: string): {
  workflowName: string;
  queueName: string;
};

/**
 * R45-4 — the subject candidate query. `$1` is the optional `--render-job` pin; when it is
 * NULL the harness's own `render-load-%` rows are excluded, so the pool cannot degrade to
 * its own residue.
 */
export declare function buildSubjectCandidateQuery(limit?: number): string;

/** R45-8 / D6 — every distinct S3 key this run's renders produced. */
export declare function renderJobTeardownKeys(
  jobs:
    | ReadonlyArray<{
        outputAssetKey?: string | null;
        thumbnailAssetKey?: string | null;
        // The caller passes whole RenderJob rows; the two keys are all this reads.
        [key: string]: unknown;
      }>
    | null
    | undefined,
): string[];

/**
 * Only the two fields the harness reads. Open-ended on purpose: the real
 * `ProjectManifest` carries a dozen more (description, style, scenes, composition…) and
 * these helpers are handed the whole thing straight off `supagloo.project.json`.
 */
export interface AudioManifestShape {
  narratorVoice?: ({ assetKey?: string | null } & Record<string, unknown>) | null;
  music?: ({ assetKey?: string | null } & Record<string, unknown>) | null;
  [key: string]: unknown;
}

/**
 * THE cost gate for brief §10 R8. (`assertCachedAudioRefs` was deleted in Step 11 —
 * R45-6 / D5: it checked only the manifest arm of this condition and nothing imported it.)
 */
export declare function assertNoProviderSpend(
  manifest: AudioManifestShape,
  workerEnv?: Record<string, string | undefined>,
): true;

export declare function maxSimultaneousRunning(
  samples: ReadonlyArray<ReadonlyArray<{ workflowUuid?: string; status?: string }>>,
): number;

export interface LoadRunJob {
  id: string;
  status: string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  outputAssetKey?: string | null;
  thumbnailAssetKey?: string | null;
}

export interface LoadRunSummary {
  total: number;
  completed: number;
  failed: number;
  canceled: number;
  unfinished: number;
  durationsSeconds: number[];
  p50Seconds: number | null;
  maxSeconds: number | null;
  spanSeconds: number | null;
  /**
   * UTILIZATION only: Σdurations ÷ span (R45-3). `> 1` implies overlap; `<= 1` implies
   * NOTHING — Step 8's M12 scored 0.0588 on a sample with a complete overlap. Use
   * {@link LoadRunSummary.maxIntervalOverlap} / {@link assertRendersRanSerially} instead.
   */
  overlapRatio: number | null;
  /** Exact: the most render execution intervals open at one instant. 1 ⇒ serial. */
  maxIntervalOverlap: number;
}

export declare function summarizeLoadRun(
  jobs: readonly LoadRunJob[],
): LoadRunSummary;

/** R45-3 — the exact sweep over start/end events; ends before starts at a tie. */
export declare function maxIntervalOverlap(
  jobs: ReadonlyArray<Pick<LoadRunJob, "startedAt" | "completedAt">> | null | undefined,
): number;

/**
 * R45-3 — THE serialization gate. Throws when more than one interval was ever open, and
 * ALSO when no interval could be measured at all (a silent pass there reads as "serial").
 */
export declare function assertRendersRanSerially(
  jobs: ReadonlyArray<Pick<LoadRunJob, "startedAt" | "completedAt">> | null | undefined,
): true;

export interface DockerStatsRow {
  name: string;
  cpuPercent: number;
  memBytes: number;
  limitBytes: number;
  memPercent: number;
}

export declare function parseDockerStatsRow(line: string): DockerStatsRow;

export interface MemorySummary {
  samples: number;
  peakBytes: number | null;
  meanBytes: number | null;
  peakPercentOfLimit: number | null;
  peakCpuPercent: number | null;
  limitBytes: number | null;
}

export declare function summarizeMemorySamples(
  samples: ReadonlyArray<Pick<DockerStatsRow, "memBytes" | "limitBytes" | "cpuPercent">>,
): MemorySummary;
