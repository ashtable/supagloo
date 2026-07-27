import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DBOS_REGISTRY_PROBE,
  DEFAULT_RENDER_COUNT,
  DEV_APP_DATABASE_URL,
  DEV_SYSTEM_DATABASE_URL,
  assertNoProviderSpend,
  assertRenderQueueSerial,
  assertRenderQueueSerialFromImage,
  assertRendersRanSerially,
  buildSubjectCandidateQuery,
  maxIntervalOverlap,
  maxSimultaneousRunning,
  parseDockerStatsRow,
  parseLoadConfig,
  readWorkflowNames,
  readWorkflowNamesFromImage,
  renderJobTeardownKeys,
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
 * Three of these functions are not conveniences, they are the row's PROOFS — and Step 11
 * corrected which three, because two of the originals did not prove what they claimed:
 *
 *   - `assertRenderQueueSerialFromImage` is D45.2(a), fixed per R45-2. "Confirm concurrency
 *     1/worker" is an assertion about config that ALREADY EXISTS (flagged "firm"), and the
 *     memory `no-long-running-samplers-to-prove-a-precondition` forbids establishing it by
 *     watching `docker stats` on a timer. It is read out of the BUILT IMAGE, before a single
 *     render is enqueued. The old source read survives as an explicitly secondary drift
 *     check: `docker-compose.override.yml` decides which tree the image came from, so no
 *     host path can claim build-context identity.
 *   - `assertRendersRanSerially` is D45.2(b), fixed per R45-3. It gates on
 *     `maxIntervalOverlap === 1`, not on `overlapRatio <= 1` — which is a utilization figure
 *     that scored 0.0588 on a sample containing a complete overlap.
 *   - `assertNoProviderSpend` is §10 R8. `ensureNarrationAudio` / `ensureMusicAudio` can
 *     only synthesize when a cached ref is absent AND a fallback model is configured, so
 *     there are two independent ways to be free and a subject failing BOTH turns N renders
 *     into N live TTS calls — real money, N times over.
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

  // -------------------------------------------------------------------------------
  // R45-7 — two flag paths silently did the OPPOSITE of what was asked.
  //
  // MEASURED before the fix: `--dry-run=1` tokenizes to the STRING "1", so
  // `flags.get("--dry-run") === true` was false and the runner fell through to the real
  // enqueue loop — N real clones, N real Chromium encodes, on the shared Compose queue,
  // for an operator who asked for a dry run. And a bare `--render-job` (value forgotten,
  // or shell-expanded to nothing) yields `true`, failed the `typeof === "string"` test,
  // and fell through to `null`, i.e. SILENT auto-selection of a different subject.
  //
  // Both contradicted this module's own contract: "Throws — never defaults around — on
  // anything that would make the run silently meaningless."
  // -------------------------------------------------------------------------------
  it.each([["--dry-run=1"], ["--dry-run=true"], ["--dry-run=false"], ["--dry-run=0"]])(
    "rejects %s rather than treating a valued --dry-run as OFF",
    (token) => {
      expect(() => parseLoadConfig([token], env)).toThrow(/--dry-run takes no value/);
    },
  );

  it("rejects `--dry-run true` (the space form tokenizes identically)", () => {
    // `--dry-run false` is the dangerous one: it reads like a disable and used to be
    // indistinguishable from `--dry-run` proper... except that it enqueued.
    expect(() => parseLoadConfig(["--dry-run", "true"], env)).toThrow(
      /--dry-run takes no value/,
    );
  });

  it("rejects a VALUELESS --render-job rather than silently auto-selecting", () => {
    expect(() => parseLoadConfig(["--render-job"], env)).toThrow(
      /--render-job requires a RenderJob id/,
    );
    expect(() => parseLoadConfig(["--render-job", "--dry-run"], env)).toThrow(
      /--render-job requires a RenderJob id/,
    );
  });

  // -------------------------------------------------------------------------------
  // R45-8 / D6 — opt-in self-teardown. DEFAULT OFF, deliberately.
  //
  // The harness's rows reach `completed`, and row 42's janitor selects only
  // failed/canceled jobs, so the residue is permanently outside its delete set. Teardown
  // deletes real rows and real MinIO objects in state SHARED with dev and with four
  // repos' e2e lanes, so it is never the default: an operator must ask.
  // -------------------------------------------------------------------------------
  it("leaves --cleanup OFF unless it is asked for", () => {
    expect(parseLoadConfig([], env).cleanup).toBe(false);
    expect(parseLoadConfig(["--cleanup"], env).cleanup).toBe(true);
  });

  it("rejects a VALUED --cleanup, the same way as --dry-run", () => {
    // `--cleanup=false` reading as "on" would be the worst possible direction for a flag
    // that deletes rows and objects.
    expect(() => parseLoadConfig(["--cleanup=false"], env)).toThrow(
      /--cleanup takes no value/,
    );
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

describe("assertNoProviderSpend — the two independent ways to be free", () => {
  // R45-6 / D5: `assertCachedAudioRefs` and its four tests were DELETED here in Step 11.
  // It checked only the manifest half of this condition, the module header advertised it as
  // "the row's proof" for §10 R8 — and `render-load.mjs` never imported it. Deleting dead
  // code beats flag-gating it: an auditor asking "is §10 R8 enforced?" must land on the gate
  // that actually runs, which is this one. The harness module now says so in as many words,
  // and `no longer imports the deleted assertCachedAudioRefs` below holds the runner to it.
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

  it("computes a UTILIZATION ratio: sum(duration) / span", () => {
    // NOT an overlap detector — see the R45-3 block below. `> 1` does imply overlap, but
    // `<= 1` implies nothing at all, because idle time anywhere in the span masks
    // arbitrary overlap elsewhere. Kept because utilization is a genuinely useful number
    // (it is how the ~0.7 s/render queue-dispatch latency in docs/render-sizing.md §2 was
    // derived); it is simply not the serialization proof it was being read as.
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

// ---------------------------------------------------------------------------------
// R45-3 — `overlapRatio <= 1` DOES NOT PROVE SERIALIZATION, and row 45's own
// acceptance column ("N queued renders complete SERIALLY per worker") rested on it.
//
// THE COUNTEREXAMPLE, produced by running the SHIPPED summarizer (Step 8 M12): two
// renders that overlap COMPLETELY plus one 50 s later report `overlapRatio 0.0588`,
// which docs/render-sizing.md read as "no two renders overlapped" and the runner printed
// as approaching "strictly serial". `overlapRatio` is a utilization figure; idle time
// anywhere in the span masks arbitrary overlap elsewhere.
//
// The exact answer is available from the same rows at no extra cost and with NO
// SAMPLING (memory: `no-long-running-samplers-to-prove-a-precondition`): a sweep over
// start/end events. `markRenderStarted` (dbos `src/workflows/render/status.ts`) stamps
// `startedAt` at PICK-UP, not at enqueue, so these are genuine execution intervals and
// the sweep is exact rather than approximate.
// ---------------------------------------------------------------------------------
describe("maxIntervalOverlap / assertRendersRanSerially (R45-3)", () => {
  const job = (id: string, start: number, end: number | null) => ({
    id,
    status: "completed",
    startedAt: new Date(start),
    completedAt: end === null ? null : new Date(end),
  });

  /** Step 8's M12 sample, verbatim: a and b overlap completely; c runs 50 s later. */
  const M12 = [
    job("a", 1_000, 2_000),
    job("b", 1_000, 2_000),
    job("c", 51_000, 52_000),
  ];

  it("reports 2 on the M12 sample that overlapRatio scores 0.0588", () => {
    expect(maxIntervalOverlap(M12)).toBe(2);
    // The defect, pinned so it cannot be re-read as a proof: the ratio really is far
    // below 1 on a sample with a full overlap in it.
    expect(summarizeLoadRun(M12).overlapRatio!).toBeCloseTo(0.0588, 3);
  });

  it("is 1 for genuinely serial intervals, ends-before-starts at a tie", () => {
    // A hand-off at the same millisecond is serial, not overlapping. Getting the tie
    // order wrong would make every clean serial run report 2 and fail the gate.
    expect(maxIntervalOverlap([job("a", 1_000, 11_000), job("b", 11_000, 21_000)])).toBe(1);
  });

  it("ignores rows with no measurable interval rather than counting them as 0-length", () => {
    expect(maxIntervalOverlap([job("a", 1_000, null), job("b", 2_000, null)])).toBe(0);
    expect(maxIntervalOverlap([])).toBe(0);
  });

  it("counts a 3-deep overlap as 3, not as 2", () => {
    expect(
      maxIntervalOverlap([
        job("a", 1_000, 9_000),
        job("b", 2_000, 8_000),
        job("c", 3_000, 7_000),
      ]),
    ).toBe(3);
  });

  it("summarizeLoadRun carries the exact figure alongside the utilization one", () => {
    const s = summarizeLoadRun(M12);
    expect(s.maxIntervalOverlap).toBe(2);
  });

  it("THE GATE rejects the M12 sample — the whole point of R45-3", () => {
    // The shipped inference (`overlapRatio <= 1` ⇒ serial) ACCEPTS this sample. That is
    // the defect, and this is the assertion that would not let it publish.
    expect(() => assertRendersRanSerially(M12)).toThrow(/2 render/);
  });

  it("THE GATE accepts a genuinely serial run", () => {
    expect(() =>
      assertRendersRanSerially([job("a", 1_000, 11_000), job("b", 11_000, 21_000)]),
    ).not.toThrow();
  });

  it("THE GATE refuses to certify a run it could not measure at all", () => {
    // A silent pass here would be the same class of green lie as parseDockerStatsRow
    // returning zeros: "0 overlaps observed" reads as "serial" when it means "no row
    // carried both timestamps".
    expect(() => assertRendersRanSerially([job("a", 1_000, null)])).toThrow(
      /no render interval/,
    );
    expect(() => assertRendersRanSerially([])).toThrow(/no render interval/);
  });
});

// ---------------------------------------------------------------------------------
// R45-4 — the harness poisoned its own subject pool.
//
// Candidate selection took the 8 most recently completed RenderJobs with no exclusion,
// and every row the harness creates ends `completed` — so after a couple of runs most of
// the eight slots are the harness's own residue, all pointing at ONE project, and the
// deliberate 8-deep fallback degrades to two or three distinct subjects.
//
// STEP 8 CORRECTION, and it is why the comment in the builder reads the way it does: the
// trigger the reviewer named cannot fire. `scripts/cleanup-e2e-repos.mjs` ARCHIVES and
// never deletes, and an archived repo is still cloneable and still serves
// `GET /contents/`. The real triggers are repo DELETION, manifest drift, and pool
// degradation itself.
// ---------------------------------------------------------------------------------
describe("buildSubjectCandidateQuery (R45-4)", () => {
  it("excludes the harness's own rows when auto-selecting", () => {
    expect(buildSubjectCandidateQuery()).toContain("NOT LIKE 'render-load-%'");
  });

  it("keeps an EXPLICIT --render-job selectable, including a render-load- id", () => {
    // The exclusion exists to stop AUTO-selection eating its own tail. An operator who
    // names a row has made a deliberate choice, and `resolveSubjectCandidates`'s error
    // message promises `--render-job <id>` works — so the exclusion must be gated on the
    // pin being absent, not applied unconditionally.
    const sql = buildSubjectCandidateQuery();
    expect(sql).toMatch(/\$1::text IS NOT NULL OR rj\.id NOT LIKE 'render-load-%'/);
    expect(sql).toMatch(/\$1::text IS NULL OR rj\.id = \$1::text/);
  });

  it("returns one row per PROJECT, so eight candidates mean eight subjects", () => {
    const sql = buildSubjectCandidateQuery();
    expect(sql).toContain('DISTINCT ON (rj."projectId")');
    // Postgres requires the DISTINCT ON expression to lead ORDER BY, so the newest-first
    // ordering the harness actually wants has to be re-applied outside the subquery.
    expect(sql).toMatch(/ORDER BY rj\."projectId", rj\."completedAt" DESC/);
    expect(sql).toMatch(/ORDER BY s\."completedAt" DESC[\s\S]*LIMIT 8/);
  });

  it("still selects only completed renders of live projects", () => {
    const sql = buildSubjectCandidateQuery();
    expect(sql).toContain("rj.status = 'completed'");
    expect(sql).toContain('p."deletedAt" IS NULL');
  });

  it("takes the candidate depth from its argument and keeps 8 as the default", () => {
    expect(buildSubjectCandidateQuery(3)).toMatch(/LIMIT 3/);
    expect(buildSubjectCandidateQuery()).toMatch(/LIMIT 8/);
  });

  it("refuses a non-integer depth rather than interpolating it into SQL", () => {
    // The only interpolated value in the whole query. A string here would be an
    // injection point in a script that runs against the shared dev database.
    expect(() => buildSubjectCandidateQuery("8; DROP TABLE \"RenderJob\"" as never)).toThrow(
      /candidate depth/,
    );
  });
});

// ---------------------------------------------------------------------------------
// R45-8 / D6 — the teardown key list.
// ---------------------------------------------------------------------------------
describe("renderJobTeardownKeys (R45-8 / D6)", () => {
  it("collects both asset keys per job and skips the absent ones", () => {
    expect(
      renderJobTeardownKeys([
        { id: "a", outputAssetKey: "p/a/output.mp4", thumbnailAssetKey: "p/a/thumb.jpg" },
        { id: "b", outputAssetKey: null, thumbnailAssetKey: "p/b/thumb.jpg" },
        { id: "c", outputAssetKey: undefined, thumbnailAssetKey: undefined },
      ]),
    ).toEqual(["p/a/output.mp4", "p/a/thumb.jpg", "p/b/thumb.jpg"]);
  });

  it("de-duplicates, so a repeated key is not deleted twice", () => {
    expect(
      renderJobTeardownKeys([
        { id: "a", outputAssetKey: "k", thumbnailAssetKey: "k" },
        { id: "b", outputAssetKey: "k", thumbnailAssetKey: null },
      ]),
    ).toEqual(["k"]);
  });

  it("is empty for an empty run rather than throwing", () => {
    expect(renderJobTeardownKeys([])).toEqual([]);
    expect(renderJobTeardownKeys(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// R45-2 — THE RUNNING CONFIGURATION IS READ OUT OF THE IMAGE, not out of a checkout.
//
// `DBOS_CHECKOUT = resolve(ROOT, "..", "supagloo-nodejs-dbos")` is the SIBLING checkout
// while `docker-compose.yml` builds `./supagloo-nodejs-dbos`, the SUBMODULE. Step 8's M13
// confirmed the two differ TODAY (the submodule had no `media-options.ts`). Three shipped
// comments claimed the source read was "literally what the running container was built
// from"; all three were unfounded.
//
// STEP 8 CORRECTION — the reviewer's FIRST fix is wrong. A gitignored
// `docker-compose.override.yml` redirects all four build contexts to the SIBLING
// checkouts, so repointing the read at the submodule path would read the wrong tree
// whenever the override is active. Only the ARTIFACT read is unconditionally correct.
// ---------------------------------------------------------------------------------
describe("the running dbos configuration is read from the built image (R45-2)", () => {
  const RUNNING = {
    QUEUE_CONFIG: {
      "git-ops": { workerConcurrency: 4 },
      "ai-generation": { workerConcurrency: 8 },
      render: { workerConcurrency: 1 },
      maintenance: { workerConcurrency: 1 },
    },
    WORKFLOW_NAMES: { render: "render", cleanupOrphanedAssets: "cleanupOrphanedAssets" },
    WORKFLOW_QUEUE: { render: "render", cleanupOrphanedAssets: "maintenance" },
  };

  it("probes a path INSIDE the image, never a host checkout path", () => {
    // The whole content of the R45-2 fix. If this ever becomes a host path again the
    // proof silently reverts to being about a file nothing was built from.
    expect(DBOS_REGISTRY_PROBE.module).toBe("/app/dist/dbos/registry.js");
    expect(DBOS_REGISTRY_PROBE.image).toBe("supagloo-dbos:latest");
    expect(DBOS_REGISTRY_PROBE.module.startsWith("/app/")).toBe(true);
    expect(DBOS_REGISTRY_PROBE.dockerArgs.join(" ")).toContain("--entrypoint node");
    expect(DBOS_REGISTRY_PROBE.dockerArgs).toContain("--rm");
  });

  it("accepts the shape the real image actually prints", () => {
    // Recorded verbatim from `docker run --rm --entrypoint node supagloo-dbos:latest -e
    // "…require('/app/dist/dbos/registry.js')…"` on this machine.
    expect(() => assertRenderQueueSerialFromImage(RUNNING)).not.toThrow();
    expect(readWorkflowNamesFromImage(RUNNING)).toEqual({
      workflowName: "render",
      queueName: "render",
    });
  });

  it("throws when the RUNNING worker is not 1/worker", () => {
    expect(() =>
      assertRenderQueueSerialFromImage({
        ...RUNNING,
        QUEUE_CONFIG: { ...RUNNING.QUEUE_CONFIG, render: { workerConcurrency: 4 } },
      }),
    ).toThrow(/workerConcurrency is 4/);
  });

  it("throws rather than guessing when the render queue entry is gone", () => {
    expect(() => assertRenderQueueSerialFromImage({ QUEUE_CONFIG: {} })).toThrow(/render/);
    expect(() => assertRenderQueueSerialFromImage(null)).toThrow(/QUEUE_CONFIG/);
  });

  it("throws rather than guessing when the render workflow/queue names are absent", () => {
    expect(() => readWorkflowNamesFromImage({ WORKFLOW_NAMES: {} })).toThrow(
      /WORKFLOW_NAMES/,
    );
    expect(() =>
      readWorkflowNamesFromImage({ WORKFLOW_NAMES: { render: "render" } }),
    ).toThrow(/WORKFLOW_QUEUE/);
  });
});

// ---------------------------------------------------------------------------------
// SOURCE FENCES over the RUNNER. `scripts/render-load.mjs` is the I/O half — no unit
// test can import it (it connects to Postgres and Docker on load), so the wiring of the
// gates above is held by reading it as text. Same pattern as api's U-RED-16/17.
// ---------------------------------------------------------------------------------
describe("scripts/render-load.mjs wires the gates it publishes numbers from", () => {
  const RUNNER = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/render-load.mjs"),
    "utf8",
  );

  it("reads the running configuration from the IMAGE (R45-2)", () => {
    expect(RUNNER).toContain("DBOS_REGISTRY_PROBE");
    expect(RUNNER).toContain("assertRenderQueueSerialFromImage");
    expect(RUNNER).toContain("readWorkflowNamesFromImage");
  });

  it("makes NO claim that a host checkout is what the container was built from", () => {
    // R45-2's three false claims, by their own words: any AFFIRMATIVE "this file is what
    // the container was built from". A `docker-compose.override.yml` can point the build
    // context at either tree, so no source read can honestly claim build-context identity.
    // The refuting sentence is required to be present, so the fence cannot be satisfied by
    // simply deleting the discussion.
    expect(RUNNER).not.toMatch(/which is the copy the running container was actually built/);
    expect(RUNNER).not.toMatch(/\bis (literally )?(the copy |what )the running container/i);
    expect(RUNNER).toMatch(/can honestly be called "what the container was built from"/);
  });

  it("gates the serialization claim on maxIntervalOverlap, not on the ratio (R45-3)", () => {
    expect(RUNNER).toContain("assertRendersRanSerially(");
    // The printed line must not re-assert the refuted inference.
    expect(RUNNER).not.toMatch(/1\.000 = strictly serial/);
    expect(RUNNER).toMatch(/utilization/i);
  });

  it("drops 'ever' from the max-simultaneous line (it sees polled snapshots only)", () => {
    expect(RUNNER).not.toMatch(/PENDING render workflows, ever/);
  });

  it("selects candidates through the shared builder (R45-4)", () => {
    expect(RUNNER).toContain("buildSubjectCandidateQuery(");
    // and does not carry a second, unguarded copy of the query.
    expect(RUNNER).not.toMatch(/FROM "RenderJob" rj/);
  });

  it("performs teardown ONLY under --cleanup (R45-8 / D6)", () => {
    expect(RUNNER).toContain("renderJobTeardownKeys");
    expect(RUNNER).toMatch(/if \(config\.cleanup\)/);
  });

  it("no longer imports the deleted assertCachedAudioRefs (R45-6 / D5)", () => {
    expect(RUNNER).not.toContain("assertCachedAudioRefs");
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
