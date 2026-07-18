import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../support/dev-config";

// Harness self-test: the CONTAINERIZED YouVersion Data Exchange stub over a real
// host port — the KJV/BSB-only constraint end to end.
const BASE = PROVIDERS.youversionBaseUrl;

describe("e2e: youversion stub (containerized)", () => {
  it("lists only KJV + BSB", async () => {
    const res = await fetch(`${BASE}/data-exchange/v1/bibles`);
    expect(res.status).toBe(200);
    const ids = (await res.json()).data
      .map((b: { id: string }) => b.id)
      .sort();
    expect(ids).toEqual(["bsb", "kjv"]);
  });

  it("serves KJV and BSB passage fixtures but refuses NIV", async () => {
    const kjv = await fetch(
      `${BASE}/data-exchange/v1/passages?version=kjv&reference=${encodeURIComponent(
        "John 3:16",
      )}`,
    );
    expect(kjv.status).toBe(200);
    expect((await kjv.json()).version).toBe("KJV");

    const bsb = await fetch(
      `${BASE}/data-exchange/v1/passages?version=bsb&reference=${encodeURIComponent(
        "Genesis 1:1",
      )}`,
    );
    expect(bsb.status).toBe(200);

    const niv = await fetch(
      `${BASE}/data-exchange/v1/passages?version=niv&reference=${encodeURIComponent(
        "John 3:16",
      )}`,
    );
    expect(niv.status).toBe(400);
  });
});
