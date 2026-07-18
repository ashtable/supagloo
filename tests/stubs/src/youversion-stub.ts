import {
  route,
  startStub,
  type StartStubOptions,
  type StubHandle,
} from "./stub-server";
import { BIBLE_COLLECTION, PASSAGES } from "./fixtures/kjv-bsb";

const ALLOWED = new Set(["kjv", "bsb"]);

/**
 * YouVersion Data Exchange stub (invented shape — the real API schema is
 * unspecified in the design docs and flagged for implementation-time
 * verification). Enforces the v1 constraint end to end: the collection endpoint
 * exposes ONLY KJV + BSB (version ids resolved at runtime, never hardcoded
 * downstream) and the passage endpoint refuses any other translation
 * (memory kjv-bsb-generation-only, design-delta §9-Q10).
 */
export function createYouVersionStub(
  options: StartStubOptions = {},
): Promise<StubHandle> {
  const state = { collectionLookups: 0, passageFetches: 0 };

  const routes = [
    route("GET", "/data-exchange/v1/bibles", (ctx) => {
      state.collectionLookups += 1;
      ctx.send(200, { data: BIBLE_COLLECTION });
    }),

    route("GET", "/data-exchange/v1/passages", (ctx) => {
      const version = (ctx.url.searchParams.get("version") ?? "").toLowerCase();
      const reference = ctx.url.searchParams.get("reference") ?? "";

      if (!ALLOWED.has(version)) {
        return ctx.send(400, {
          error: "unsupported_version",
          message: "Only KJV and BSB are available for generation",
        });
      }
      const fixture = PASSAGES[`${version}|${reference}`];
      if (!fixture) {
        return ctx.send(404, { error: "passage_not_found", reference });
      }
      state.passageFetches += 1;
      ctx.send(200, {
        version: version.toUpperCase(),
        reference: fixture.reference,
        copyright: "Public Domain",
        passages: [
          {
            reference: fixture.reference,
            verses: fixture.verses,
            text: fixture.verses.map((v) => v.text).join(" "),
          },
        ],
      });
    }),
  ];

  return startStub(
    {
      kind: "youversion",
      routes,
      state,
      onReset: () => {
        state.collectionLookups = 0;
        state.passageFetches = 0;
      },
    },
    options,
  );
}
