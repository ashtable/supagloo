import {
  route,
  startStub,
  type StartStubOptions,
  type StubHandle,
} from "./stub-server";

/**
 * Gloo stub — client-credentials OAuth2 token mint (Basic auth
 * clientId:clientSecret, design-delta §2.5, confirmed against
 * supagloo-nextjs/lib/gloo/llm-client.ts) plus the text-only chat-completions
 * endpoint. Gloo has NO media modalities (memory openrouter-media-and-ai-sdk-split).
 */
export function createGlooStub(
  options: StartStubOptions = {},
): Promise<StubHandle> {
  const state = { tokensIssued: 0, chatCompletions: 0 };

  const routes = [
    route("POST", "/oauth2/token", (ctx) => {
      const auth = ctx.header("authorization");
      if (!auth || !/^Basic\s+.+/.test(auth)) {
        return ctx.send(401, { error: "invalid_client" });
      }
      if (ctx.form().get("grant_type") !== "client_credentials") {
        return ctx.send(400, { error: "unsupported_grant_type" });
      }
      state.tokensIssued += 1;
      ctx.send(200, {
        access_token: `gloo_stub_${state.tokensIssued}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "api",
      });
    }),

    route("POST", "/ai/v2/chat-completions", (ctx) => {
      const auth = ctx.header("authorization");
      if (!auth || !/^Bearer\s+gloo_/.test(auth)) {
        return ctx.send(401, { error: "unauthorized" });
      }
      state.chatCompletions += 1;
      ctx.send(200, {
        id: `gloo_chatcmpl_${state.chatCompletions}`,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Stubbed Gloo completion." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }),
  ];

  return startStub(
    {
      kind: "gloo",
      routes,
      state,
      onReset: () => {
        state.tokensIssued = 0;
        state.chatCompletions = 0;
      },
    },
    options,
  );
}
