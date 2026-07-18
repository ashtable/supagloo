import { describe, expect, it } from "vitest";
import { API } from "../support/dev-config";

// The Task #8 e2e acceptance: with the full Compose stack up (globalSetup builds
// the api image, `migrate` applies database-lib's migrations, then `api`
// starts), the Fastify service answers GET /healthz over real HTTP with 200.
describe("e2e: api /healthz over real HTTP", () => {
  it("returns 200 with a minimal liveness body", async () => {
    const res = await fetch(`${API.baseUrl}/healthz`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
