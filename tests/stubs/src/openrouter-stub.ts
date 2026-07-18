import {
  route,
  startStub,
  type StartStubOptions,
  type StubHandle,
} from "./stub-server";

export interface OpenRouterStubOptions extends StartStubOptions {
  /** Polls (GETs) before a video job reports `completed`. Default 2. */
  pollsToComplete?: number;
}

interface VideoJob {
  id: string;
  pollCount: number;
  pollsToComplete: number;
}

const FAKE_MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
const FAKE_MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

/**
 * OpenRouter stub. The centerpiece is the async VIDEO-JOB state machine
 * (design-delta §7 workflow 8, memory openrouter-media-and-ai-sdk-split):
 * submit -> 202 pending, poll pending -> in_progress -> completed, then content
 * download. Submits are IDEMPOTENT on the `Idempotency-Key` header so the DBOS
 * submit step survives crash/replay without re-issuing a job id (the stub's
 * `videoJobsCreated` counter stays 1 across duplicate submits). Also: browser
 * PKCE key exchange (§6a), OpenAI-compatible chat-completions for AI-SDK
 * `generateObject`, raw-byte-stream TTS, credit balance, and model discovery.
 */
export function createOpenRouterStub(
  options: OpenRouterStubOptions = {},
): Promise<StubHandle> {
  const defaultPolls =
    options.pollsToComplete ??
    Number(process.env.STUB_VIDEO_POLLS_TO_COMPLETE ?? "2");

  const state = {
    keysIssued: 0,
    chatCompletions: 0,
    speechRequests: 0,
    videoJobsCreated: 0,
  };
  const jobs = new Map<string, VideoJob>();
  const idempotency = new Map<string, string>();

  const statusFor = (job: VideoJob): string => {
    if (job.pollCount >= job.pollsToComplete) return "completed";
    if (job.pollCount >= 1) return "in_progress";
    return "pending";
  };

  const routes = [
    route("POST", "/api/v1/auth/keys", (ctx) => {
      const body = ctx.json<{ code?: string; code_verifier?: string }>() ?? {};
      if (!body.code || !body.code_verifier) {
        return ctx.send(400, { error: { message: "invalid_grant" } });
      }
      state.keysIssued += 1;
      ctx.send(200, {
        key: `sk-or-v1-stub-${state.keysIssued}`,
        user_id: "usr_stub",
      });
    }),

    route("GET", "/api/v1/credits", (ctx) => {
      ctx.send(200, { data: { total_credits: 100, total_usage: 12.5 } });
    }),

    route("POST", "/api/v1/chat/completions", (ctx) => {
      const body =
        ctx.json<{
          model?: string;
          response_format?: { type?: string };
        }>() ?? {};
      state.chatCompletions += 1;
      const content =
        body.response_format?.type === "json_schema"
          ? JSON.stringify({ stub: true })
          : "This is a stubbed completion.";
      ctx.send(200, {
        id: `chatcmpl_${state.chatCompletions}`,
        object: "chat.completion",
        model: body.model ?? "stub/text-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }),

    route("POST", "/api/v1/audio/speech", (ctx) => {
      state.speechRequests += 1;
      ctx.sendRaw(200, FAKE_MP3, {
        "content-type": "audio/mpeg",
        "x-generation-id": `gen_stub_${state.speechRequests}`,
      });
    }),

    route("POST", "/api/v1/videos", (ctx) => {
      const idemKey = ctx.header("idempotency-key");
      if (idemKey && idempotency.has(idemKey)) {
        const existing = jobs.get(idempotency.get(idemKey)!)!;
        return ctx.send(202, {
          id: existing.id,
          polling_url: `${ctx.url.origin}/api/v1/videos/${existing.id}`,
          status: statusFor(existing),
        });
      }
      const perRequest = Number(ctx.header("x-stub-polls-to-complete"));
      const id = `vid_${state.videoJobsCreated + 1}`;
      const job: VideoJob = {
        id,
        pollCount: 0,
        pollsToComplete: Number.isFinite(perRequest) && perRequest > 0
          ? perRequest
          : defaultPolls,
      };
      jobs.set(id, job);
      if (idemKey) idempotency.set(idemKey, id);
      state.videoJobsCreated += 1;
      ctx.send(202, {
        id,
        polling_url: `${ctx.url.origin}/api/v1/videos/${id}`,
        status: "pending",
      });
    }),

    route("GET", "/api/v1/videos/models", (ctx) => {
      ctx.send(200, { data: [{ id: "stub/video-model" }] });
    }),

    route("GET", "/api/v1/videos/:id/content", (ctx) => {
      const job = jobs.get(ctx.params.id);
      if (!job) return ctx.send(404, { error: { message: "job not found" } });
      if (statusFor(job) !== "completed") {
        return ctx.send(409, { error: { message: "job not completed" } });
      }
      ctx.send(200, {
        unsigned_urls: [
          `${ctx.url.origin}/api/v1/videos/${job.id}/download?index=0`,
        ],
      });
    }),

    route("GET", "/api/v1/videos/:id/download", (ctx) => {
      ctx.sendRaw(200, FAKE_MP4, { "content-type": "video/mp4" });
    }),

    route("GET", "/api/v1/videos/:id", (ctx) => {
      const job = jobs.get(ctx.params.id);
      if (!job) return ctx.send(404, { error: { message: "job not found" } });
      job.pollCount += 1;
      ctx.send(200, { id: job.id, status: statusFor(job) });
    }),

    route("GET", "/api/v1/models", (ctx) => {
      ctx.send(200, {
        data: [{ id: "stub/text-model" }, { id: "stub/speech-model" }],
      });
    }),
  ];

  return startStub(
    {
      kind: "openrouter",
      routes,
      state,
      onReset: () => {
        state.keysIssued = 0;
        state.chatCompletions = 0;
        state.speechRequests = 0;
        state.videoJobsCreated = 0;
        jobs.clear();
        idempotency.clear();
      },
    },
    options,
  );
}
