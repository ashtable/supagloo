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
}

export declare function parseLoadConfig(
  argv?: readonly string[],
  env?: Record<string, string | undefined>,
): LoadConfig;

export declare function assertRenderQueueSerial(registrySource: string): true;

export declare function readWorkflowNames(workflowsSource: string): {
  workflowName: string;
  queueName: string;
};

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

export declare function assertCachedAudioRefs(manifest: AudioManifestShape): true;

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
  /** sum(durations) / span. 1.0 ⇒ strictly serial; > 1 ⇒ renders overlapped. */
  overlapRatio: number | null;
}

export declare function summarizeLoadRun(
  jobs: readonly LoadRunJob[],
): LoadRunSummary;

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
