import {
  route,
  startStub,
  type StartStubOptions,
  type StubHandle,
} from "./stub-server";
import { BIBLE_COLLECTION, PASSAGES } from "./fixtures/kjv-bsb";

const ALLOWED = new Set(["kjv", "bsb"]);

/**
 * Auth / userinfo contract for `POST /v1/auth/youversion` (Task #10, invented —
 * see scratch/auth-and-sessions.md §0). The API verifies a forwarded YouVersion
 * access token by calling `GET /auth/v1/userinfo` with it as a bearer, then maps
 * the returned userinfo onto the User model.
 */
interface YouVersionUserInfo {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  avatar_url: string | null;
}

/** Access tokens that model an expired/invalid credential (401). */
const INVALID_ACCESS_TOKENS = new Set(["yv-access-invalid", "yv-access-expired"]);

/** Canonical named users (assert exact fields in tests). */
const USERINFO_FIXTURES: Record<string, YouVersionUserInfo> = {
  "yv-access-ada": {
    id: "yv-user-1001",
    first_name: "Ada",
    last_name: "Lovelace",
    email: "ada@example.test",
    avatar_url: "https://cdn.example.test/avatars/ada.png",
  },
};

/** Extract the bearer token, or "" if absent/malformed. */
function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? "").trim());
  return match ? match[1].trim() : "";
}

/** Any non-fixture, non-invalid token maps to a STABLE derived user, so tests can
 *  drive an arbitrary-but-deterministic identity (same token ⇒ same user). */
function deriveUserInfo(token: string): YouVersionUserInfo {
  const slug = token.replace(/[^A-Za-z0-9_-]/g, "") || "user";
  return {
    id: `yv_${slug}`,
    first_name: slug.charAt(0).toUpperCase() + slug.slice(1),
    last_name: "Tester",
    email: `${slug}@youversion.test`,
    avatar_url: null,
  };
}

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
  const state = {
    collectionLookups: 0,
    passageFetches: 0,
    userinfoOk: 0,
    userinfoRejected: 0,
  };

  const routes = [
    // Task #10: verify a forwarded YouVersion access token → userinfo.
    route("GET", "/auth/v1/userinfo", (ctx) => {
      const token = bearerToken(ctx.header("authorization"));
      if (!token || INVALID_ACCESS_TOKENS.has(token)) {
        state.userinfoRejected += 1;
        return ctx.send(401, { error: "invalid_token" });
      }
      state.userinfoOk += 1;
      ctx.send(200, USERINFO_FIXTURES[token] ?? deriveUserInfo(token));
    }),

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
        state.userinfoOk = 0;
        state.userinfoRejected = 0;
      },
    },
    options,
  );
}
