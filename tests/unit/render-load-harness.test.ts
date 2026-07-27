import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_COUNT,
  DEV_APP_DATABASE_URL,
  DEV_SYSTEM_DATABASE_URL,
  assertCachedAudioRefs,
  assertNoProviderSpend,
  assertRenderQueueSerial,
  maxSimultaneousRunning,
  parseDockerStatsRow,
  parseLoadConfig,
  readWorkflowNames,
  summarizeLoadRun,
  summarizeMemorySamples,
} from "../../scripts/render-load-harness.mjs";

/**
 * PLAN ROW 45 — the pure half of the render load harness.
 *
 * The row's Unit column is exactly "Harness utilities (config parsing, result
 * summarization)", and D45.1 makes the harness a standalone `npm run load:render` script
 * rather than a vitest spec: a load run occupies the shared Compose `render` queue for
 * minutes and must never gate a suite. So the I/O lives in `scripts/render-load.mjs` and
 * everything decidable lives here, in a module with no imports of its own.
 *
 * Two of these functions are not conveniences, they are the row's PROOFS:
 *
 *   - `assertRenderQueueSerial` is D45.2(a). "Confirm concurrency 1/worker" is an
 *     assertion about config that ALREADY EXISTS (registry.ts:43-47, flagged "firm"), and
 *     the memory `no-long-running-samplers-to-prove-a-precondition` forbids establishing it
 *     by watching `docker stats` on a timer. It is read out of the dbos checkout's source
 *     and checked INLINE, before a single render is enqueued.
 *   - `assertCachedAudioRefs` is §10 R8. `ensureNarrationAudio` / `ensureMusicAudio`
 *     synthesize only when the manifest lacks cached asset refs, so a subject WITHOUT them
 *     turns N renders into N live OpenRouter TTS calls — real money, N times over. Checked
 *     against the manifest actually in the repo, at the point of use.
 */

describe("parseLoadConfig", () => {
  const env = { DATABASE_URL: "postgres://u:p@h/app", DBOS_DATABASE_URL: "postgres://u:p@h/sys" };

  it("defaults N to 2 — the minimum that can prove serialization", () => {
    // D45.3: each render is a real github.com clone + `npm ci` + a real Chromium encode,
    // so N is real minutes of real work. Two is the smallest N whose timeline can show
    // that the second render did not start until the first finished.
    expect(parseLoadConfig([], env).count).toBe(2);
    expect(DEFAULT_RENDER_COUNT).toBe(2);
  });

  it("accepts --count and its = form", () => {
    expect(parseLoadConfig(["--count", "5"], env).count).toBe(5);
    expect(parseLoadConfig(["--count=3"], env).count).toBe(3);
  });

  it.each([["0"], ["-1"], ["1.5"], ["abc"], [""]])(
    "rejects --count %s by name",
    (bad) => {
      expect(() => parseLoadConfig(["--count", bad], env)).toThrow(/--count/);
    },
  );

  it("carries the app and system database urls through from the environment", () => {
    const cfg = parseLoadConfig([], env);
    expect(cfg.appDatabaseUrl).toBe("postgres://u:p@h/app");
    expect(cfg.systemDatabaseUrl).toBe("postgres://u:p@h/sys");
  });

  it("uses the DEFAULT dbos system schema, never a lane schema (§10 R5)", () => {
    // The inverse of every e2e lane in this project. The harness's whole point is that the
    // CONTAINERISED worker performs the renders, and the container polls the default
    // `dbos` schema — enqueue into a `dbos_e2e_*` schema and the harness hangs forever
    // with no error anywhere.
    expect(parseLoadConfig([], env).systemDatabaseSchema).toBe("dbos");
  });

  it("refuses a lane schema even when one is exported into the environment", () => {
    // The api/dbos e2e lanes export DBOS_SYSTEM_DATABASE_SCHEMA into the shell they run
    // in. Silently inheriting it is the hang described above, so it is rejected loudly.
    expect(() =>
      parseLoadConfig([], { ...env, DBOS_SYSTEM_DATABASE_SCHEMA: "dbos_e2e_dbos_render" }),
    ).toThrow(/DBOS_SYSTEM_DATABASE_SCHEMA/);
  });

  it("takes an explicit subject and a dry-run flag", () => {
    const cfg = parseLoadConfig(["--render-job", "render-abc", "--dry-run"], env);
    expect(cfg.subjectRenderJobId).toBe("render-abc");
    expect(cfg.dryRun).toBe(true);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseLoadConfig(["--concurrency", "4"], env)).toThrow(/--concurrency/);
  });

  it("falls back to the Compose dev DSNs, matching tests/support/dev-config.ts", () => {
    // Root's untracked `.env` carries CREDENTIALS only — the two DSNs are never set in it,
    // because every root helper defaults them to the published Compose values. Requiring
    // them here would make `npm run load:render` fail on a stack that is up and healthy.
    const cfg = parseLoadConfig([], {});
    expect(cfg.appDatabaseUrl).toBe(DEV_APP_DATABASE_URL);
    expect(cfg.systemDatabaseUrl).toBe(DEV_SYSTEM_DATABASE_URL);
    expect(cfg.appDatabaseUrl).toMatch(/\/supagloo$/);
    expect(cfg.systemDatabaseUrl).toMatch(/\/supagloo_dbos$/);
  });
});

describe("assertRenderQueueSerial (D45.2a — structural, not sampled)", () => {
  const GOOD = `
export const QUEUE_CONFIG = {
  "git-ops": { workerConcurrency: 4 },
  render: { workerConcurrency: 1 },
} as const;
`;

  it("passes on the shipped registry shape", () => {
    expect(() => assertRenderQueueSerial(GOOD)).not.toThrow();
  });

  it("throws when the render queue is not 1/worker", () => {
    expect(() =>
      assertRenderQueueSerial(GOOD.replace("render: { workerConcurrency: 1 }", "render: { workerConcurrency: 2 }")),
    ).toThrow(/workerConcurrency/);
  });

  it("throws when the render queue entry is gone entirely", () => {
    expect(() => assertRenderQueueSerial("export const QUEUE_CONFIG = {} as const;")).toThrow(
      /render/,
    );
  });

  it("is not satisfied by a COMMENT that mentions the value", () => {
    // The registry's prose talks about `render` = 1 at length. A guard that greps the
    // whole file would stay green after someone changed the code and left the comment.
    expect(() =>
      assertRenderQueueSerial(`
// render: { workerConcurrency: 1 } is firm — Chromium is heavy.
export const QUEUE_CONFIG = {
  render: { workerConcurrency: 8 },
} as const;
`),
    ).toThrow(/workerConcurrency/);
  });
});

describe("readWorkflowNames", () => {
  it("reads both names out of db-lib's source", () => {
    const { workflowName, queueName } = readWorkflowNames(`
export const RENDER_WORKFLOW_NAME = "render" as const;
export const RENDER_QUEUE_NAME = "render" as const;
`);
    expect(workflowName).toBe("render");
    expect(queueName).toBe("render");
  });

  it("matches the LIVE db-lib source — the workflow is 'render', not 'renderWorkflow'", () => {
    // The name a reader guesses is wrong, and an enqueue under a wrong name is durably
    // accepted and never dequeued: the run would poll to its deadline and report
    // "0 completed", which looks like a product failure rather than a typo.
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../supagloo-database-lib/src/workflows.ts",
      ),
      "utf8",
    );
    expect(readWorkflowNames(source)).toEqual({
      workflowName: "render",
      queueName: "render",
    });
  });

  it("throws rather than guessing when the constants cannot be found", () => {
    expect(() => readWorkflowNames("export const NOPE = 1;")).toThrow(
      /RENDER_WORKFLOW_NAME/,
    );
  });
});

describe("assertCachedAudioRefs (§10 R8 — N costs time, not money)", () => {
  const cached = {
    narratorVoice: { description: "warm", assetKey: "projects/p/assets/n" },
    music: { style: "pads", assetKey: "projects/p/assets/m" },
  };

  it("passes when both tracks carry a cached asset ref", () => {
    expect(() => assertCachedAudioRefs(cached)).not.toThrow();
  });

  it("throws, naming narratorVoice, when the narration ref is missing", () => {
    expect(() =>
      assertCachedAudioRefs({ ...cached, narratorVoice: { description: "warm" } }),
    ).toThrow(/narratorVoice/);
  });

  it("throws, naming music, when the music ref is missing", () => {
    expect(() => assertCachedAudioRefs({ ...cached, music: { style: "pads" } })).toThrow(
      /music/,
    );
  });

  it("throws when the music block is absent altogether", () => {
    expect(() => assertCachedAudioRefs({ narratorVoice: cached.narratorVoice })).toThrow(
      /music/,
    );
  });
});

describe("assertNoProviderSpend — the two independent ways to be free", () => {
  const noRefs = { narratorVoice: { description: "warm" } };
  const bothRefs = {
    narratorVoice: { description: "warm", assetKey: "projects/p/assets/n" },
    music: { style: "pads", assetKey: "projects/p/assets/m" },
  };

  it("passes when the worker has no fallback models, even with NO cached refs", () => {
    // This is the shipped Compose case, and it is why checking only the manifest was too
    // strict: `planAudioTrack` cannot synthesize without a model id, so an unset model is
    // as good a cost guarantee as a cached ref.
    expect(() =>
      assertNoProviderSpend(noRefs, {
        RENDER_NARRATION_MODEL: "",
        RENDER_MUSIC_MODEL: "",
      }),
    ).not.toThrow();
  });

  it("passes when the manifest carries refs, even with fallback models configured", () => {
    expect(() =>
      assertNoProviderSpend(bothRefs, {
        RENDER_NARRATION_MODEL: "some/tts",
        RENDER_MUSIC_MODEL: "some/music",
      }),
    ).not.toThrow();
  });

  it("throws, naming the track and the variable, when BOTH arms fail", () => {
    expect(() =>
      assertNoProviderSpend(noRefs, { RENDER_NARRATION_MODEL: "some/tts" }),
    ).toThrow(/narration.*RENDER_NARRATION_MODEL/s);
  });

  it("names music independently of narration", () => {
    expect(() =>
      assertNoProviderSpend(
        { ...noRefs, narratorVoice: bothRefs.narratorVoice },
        { RENDER_MUSIC_MODEL: "some/music" },
      ),
    ).toThrow(/music.*RENDER_MUSIC_MODEL/s);
  });

  it("treats an absent variable the same as an empty one", () => {
    expect(() => assertNoProviderSpend(noRefs, {})).not.toThrow();
  });
});

describe("maxSimultaneousRunning (D45.2b — the observational half)", () => {
  const sample = (...statuses: string[]) =>
    statuses.map((status, i) => ({ workflowUuid: `w${i}`, status }));

  it("counts PENDING workflows in one snapshot", () => {
    expect(maxSimultaneousRunning([sample("PENDING", "ENQUEUED", "SUCCESS")])).toBe(1);
  });

  it("takes the maximum across snapshots, not the last", () => {
    expect(
      maxSimultaneousRunning([
        sample("PENDING", "ENQUEUED"),
        sample("SUCCESS", "PENDING"),
        sample("SUCCESS", "SUCCESS"),
      ]),
    ).toBe(1);
  });

  it("reports 2 when two renders were ever PENDING at once (the failure it must catch)", () => {
    expect(maxSimultaneousRunning([sample("PENDING", "PENDING")])).toBe(2);
  });

  it("is 0 for an empty run rather than throwing", () => {
    expect(maxSimultaneousRunning([])).toBe(0);
    expect(maxSimultaneousRunning([[]])).toBe(0);
  });
});

describe("summarizeLoadRun", () => {
  const job = (id: string, status: string, start: number, end: number | null) => ({
    id,
    status,
    startedAt: start === 0 ? null : new Date(start),
    completedAt: end === null ? null : new Date(end),
  });

  it("splits terminal outcomes and reports wall clocks in seconds", () => {
    const s = summarizeLoadRun([
      job("a", "completed", 1_000, 11_000),
      job("b", "completed", 11_000, 41_000),
      job("c", "failed", 41_000, 43_000),
    ]);
    expect(s.total).toBe(3);
    expect(s.completed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.durationsSeconds).toEqual([10, 30, 2]);
    expect(s.p50Seconds).toBe(10);
    expect(s.maxSeconds).toBe(30);
  });

  it("reports the span from first start to last finish", () => {
    const s = summarizeLoadRun([
      job("a", "completed", 1_000, 11_000),
      job("b", "completed", 11_000, 41_000),
    ]);
    expect(s.spanSeconds).toBe(40);
  });

  it("computes an overlap ratio that is ~1 when the work ran strictly serially", () => {
    // sum(duration) / span. Exactly 1 means no two renders overlapped by even a tick;
    // greater than 1 means they did. This is what the timeline claim in docs/ rests on.
    const s = summarizeLoadRun([
      job("a", "completed", 1_000, 11_000),
      job("b", "completed", 11_000, 41_000),
    ]);
    expect(s.overlapRatio).toBeCloseTo(1, 6);
    const overlapped = summarizeLoadRun([
      job("a", "completed", 1_000, 21_000),
      job("b", "completed", 1_000, 21_000),
    ]);
    expect(overlapped.overlapRatio).toBeCloseTo(2, 6);
  });

  it("counts a job that never reached a terminal state as unfinished, not as fast", () => {
    const s = summarizeLoadRun([job("a", "running", 1_000, null)]);
    expect(s.unfinished).toBe(1);
    expect(s.durationsSeconds).toEqual([]);
    expect(s.p50Seconds).toBeNull();
  });

  it("returns a null p50 for an empty run rather than NaN", () => {
    const s = summarizeLoadRun([]);
    expect(s.total).toBe(0);
    expect(s.p50Seconds).toBeNull();
    expect(s.maxSeconds).toBeNull();
    expect(s.overlapRatio).toBeNull();
  });
});

describe("parseDockerStatsRow / summarizeMemorySamples", () => {
  it("parses a `docker stats --no-stream` row into bytes and percents", () => {
    const row = parseDockerStatsRow("supagloo-dbos-1|12.34%|1.507GiB / 7.653GiB|19.69%");
    expect(row.name).toBe("supagloo-dbos-1");
    expect(row.cpuPercent).toBeCloseTo(12.34, 5);
    expect(row.memBytes).toBeCloseTo(1.507 * 1024 ** 3, 0);
    expect(row.limitBytes).toBeCloseTo(7.653 * 1024 ** 3, 0);
    expect(row.memPercent).toBeCloseTo(19.69, 5);
  });

  it("handles MiB and plain-byte units", () => {
    expect(parseDockerStatsRow("c|0%|512MiB / 2GiB|25%").memBytes).toBeCloseTo(
      512 * 1024 ** 2,
      0,
    );
    expect(parseDockerStatsRow("c|0%|900B / 2GiB|0%").memBytes).toBe(900);
  });

  it("throws on an unparseable row instead of reporting a silent zero", () => {
    // A zero peak RSS in the sizing doc would be a green lie: it reads as "this workload
    // needs no memory" rather than "the sampler broke".
    expect(() => parseDockerStatsRow("garbage")).toThrow(/docker stats/);
  });

  it("summarizes peak and mean memory across samples", () => {
    const s = summarizeMemorySamples([
      { memBytes: 100, limitBytes: 1000, cpuPercent: 10 },
      { memBytes: 300, limitBytes: 1000, cpuPercent: 90 },
      { memBytes: 200, limitBytes: 1000, cpuPercent: 50 },
    ]);
    expect(s.samples).toBe(3);
    expect(s.peakBytes).toBe(300);
    expect(s.meanBytes).toBe(200);
    expect(s.peakPercentOfLimit).toBeCloseTo(30, 5);
    expect(s.peakCpuPercent).toBe(90);
  });

  it("reports nulls, not zeros, when nothing was sampled", () => {
    const s = summarizeMemorySamples([]);
    expect(s.samples).toBe(0);
    expect(s.peakBytes).toBeNull();
    expect(s.meanBytes).toBeNull();
  });
});
