import { describe, expect, it } from "vitest";
import { createCallLog } from "../stubs/src/call-log";

// The shared call-count bookkeeping every stub mounts behind `GET /__stub/calls`.
// Records one key per matched request; snapshot is a copy (callers can't mutate
// the live counters); reset zeroes everything for test isolation.
describe("stub call-log", () => {
  it("starts empty", () => {
    const log = createCallLog();
    expect(log.total).toBe(0);
    expect(log.snapshot()).toEqual({ total: 0, byRoute: {} });
  });

  it("counts per route key and tracks a running total", () => {
    const log = createCallLog();
    log.record("POST /a");
    log.record("POST /a");
    log.record("GET /b");

    expect(log.total).toBe(3);
    expect(log.snapshot().byRoute).toEqual({ "POST /a": 2, "GET /b": 1 });
  });

  it("returns a defensive copy from snapshot", () => {
    const log = createCallLog();
    log.record("GET /x");
    const snap = log.snapshot();
    snap.byRoute["GET /x"] = 999;
    snap.total = 999;

    expect(log.total).toBe(1);
    expect(log.snapshot().byRoute["GET /x"]).toBe(1);
  });

  it("reset zeroes the counters", () => {
    const log = createCallLog();
    log.record("GET /x");
    log.record("GET /y");
    log.reset();

    expect(log.total).toBe(0);
    expect(log.snapshot()).toEqual({ total: 0, byRoute: {} });
  });
});
