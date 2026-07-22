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
// PNG magic number + a couple of bytes — enough for the image workflow to upload real bytes.
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
    imageRequests: 0,
  };
  const jobs = new Map<string, VideoJob>();
  const idempotency = new Map<string, string>();
  // Task #30: a PROGRAMMABLE chat-response queue (set via POST /__admin/chat-script). Each
  // /api/v1/chat/completions call shifts one entry — a non-2xx `status` drives a provider
  // step retry, a 2xx `body` becomes the `message.content` (JSON string) so a test can drive
  // the exact §6d sequences (503-then-200 retry, malformed-then-valid repair). Empty queue ⇒
  // the default {stub:true} behavior (the task-29 providers e2e is unaffected).
  const chatScript: Array<{ status: number; body?: unknown }> = [];
  // Task #33: a PROGRAMMABLE speech-response queue (set via POST /__admin/speech-script). Each
  // /api/v1/audio/speech call shifts one entry — a non-2xx `status` drives a provider MEDIA_RETRY
  // (the generateAudio "failure mid-stream retries cleanly" e2e). Empty queue ⇒ the default 200
  // raw-mp3 behavior, so narration/music happy paths are unaffected. Music reuses this same
  // endpoint (decision D2), so both audio kinds share it and the speechRequests counter.
  const speechScript: Array<{ status: number }> = [];

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

    // Task #30: program the next N chat responses (shifted one per chat call).
    route("POST", "/__admin/chat-script", (ctx) => {
      const body = ctx.json<{ responses?: Array<{ status: number; body?: unknown }> }>() ?? {};
      chatScript.length = 0;
      if (Array.isArray(body.responses)) chatScript.push(...body.responses);
      ctx.send(200, { ok: true, queued: chatScript.length });
    }),

    route("POST", "/api/v1/chat/completions", (ctx) => {
      const body =
        ctx.json<{
          model?: string;
          response_format?: { type?: string };
        }>() ?? {};
      state.chatCompletions += 1;

      // If a response is scripted, honor it (drives retry / repair sequences).
      const scripted = chatScript.shift();
      if (scripted) {
        if (scripted.status >= 400) {
          return ctx.send(scripted.status, {
            error: { message: `scripted status ${scripted.status}` },
          });
        }
        const scriptedContent =
          typeof scripted.body === "string"
            ? scripted.body
            : JSON.stringify(scripted.body ?? {});
        return ctx.send(scripted.status, {
          id: `chatcmpl_${state.chatCompletions}`,
          object: "chat.completion",
          model: body.model ?? "stub/text-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: scriptedContent },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      }

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

    // Task #33: program the next N speech responses (shifted one per speech call). A
    // non-2xx entry makes /api/v1/audio/speech fail (→ MEDIA_RETRY); an empty queue ⇒ 200 mp3.
    route("POST", "/__admin/speech-script", (ctx) => {
      const body = ctx.json<{ responses?: Array<{ status: number }> }>() ?? {};
      speechScript.length = 0;
      if (Array.isArray(body.responses)) speechScript.push(...body.responses);
      ctx.send(200, { ok: true, queued: speechScript.length });
    }),

    // Raw-byte-stream TTS (design-delta §7 workflow 7): audio/mpeg body + X-Generation-Id
    // header, NOT JSON. narration AND music both hit this endpoint (decision D2 — music reuses
    // the OpenAI-Audio-Speech contract with a music model). Honors the programmable
    // speech-script queue so a test can drive a 503-then-200 retry sequence.
    route("POST", "/api/v1/audio/speech", (ctx) => {
      state.speechRequests += 1;
      const scripted = speechScript.shift();
      if (scripted && scripted.status >= 400) {
        return ctx.send(scripted.status, {
          error: { message: `scripted status ${scripted.status}` },
        });
      }
      ctx.sendRaw(200, FAKE_MP3, {
        "content-type": "audio/mpeg",
        "x-generation-id": `gen_stub_${state.speechRequests}`,
      });
    }),

    // Task #32: OpenAI-Images-compatible image generation. `POST /api/v1/images/generations`
    // → { created, data: [{ url }] }; the URL points at the download route below which serves
    // the fake PNG bytes. The generateImage workflow calls this (callImageModel), then fetches
    // the URL (fetchAssetBytes), then uploads the bytes to S3.
    route("POST", "/api/v1/images/generations", (ctx) => {
      state.imageRequests += 1;
      const id = state.imageRequests;
      ctx.send(200, {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: `${ctx.url.origin}/api/v1/images/download/${id}` }],
      });
    }),

    route("GET", "/api/v1/images/download/:id", (ctx) => {
      ctx.sendRaw(200, FAKE_PNG, { "content-type": "image/png" });
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

    // Model discovery (design-delta §7). Real OpenRouter filters by
    // `output_modalities`; the DBOS provider layer (task #29) resolves ids by
    // modality at call time, so the stub carries per-model `output_modalities` and
    // filters when the query param is present (comma-separated ⇒ ANY-overlap). No
    // param ⇒ the full catalogue. Keeps model ids resolvable-not-hardcoded end to end.
    route("GET", "/api/v1/models", (ctx) => {
      const catalogue = [
        { id: "stub/text-model", output_modalities: ["text"] },
        { id: "stub/speech-model", output_modalities: ["audio"] },
      ];
      const requested = (ctx.url.searchParams.get("output_modalities") ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      const data =
        requested.length === 0
          ? catalogue
          : catalogue.filter((m) =>
              m.output_modalities.some((mod) => requested.includes(mod)),
            );
      ctx.send(200, { data });
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
        state.imageRequests = 0;
        jobs.clear();
        idempotency.clear();
        chatScript.length = 0;
        speechScript.length = 0;
      },
    },
    options,
  );
}
