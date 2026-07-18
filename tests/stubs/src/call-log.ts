/**
 * Call-count bookkeeping shared by every stub. The dispatcher records one key
 * per matched request (keyed by the route TEMPLATE, e.g.
 * `POST /app/installations/:installationId/access_tokens`) so tests can assert
 * how many times each contract was exercised. Exposed to tests via each stub's
 * `GET /__stub/calls` introspection endpoint.
 */
export interface CallLogSnapshot {
  total: number;
  byRoute: Record<string, number>;
}

export interface CallLog {
  record(key: string): void;
  readonly total: number;
  snapshot(): CallLogSnapshot;
  reset(): void;
}

export function createCallLog(): CallLog {
  let counts: Record<string, number> = {};
  let total = 0;

  return {
    record(key: string): void {
      counts[key] = (counts[key] ?? 0) + 1;
      total += 1;
    },
    get total(): number {
      return total;
    },
    snapshot(): CallLogSnapshot {
      // Defensive copy — callers must not be able to mutate the live counters.
      return { total, byRoute: { ...counts } };
    },
    reset(): void {
      counts = {};
      total = 0;
    },
  };
}
