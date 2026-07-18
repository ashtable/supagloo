import { createGithubStub } from "./github-stub";
import { createGlooStub } from "./gloo-stub";
import { createGitServer } from "./git-server";
import { createOpenRouterStub } from "./openrouter-stub";
import { createYouVersionStub } from "./youversion-stub";
import type { StubHandle } from "./stub-server";

/**
 * Container entrypoint: one image serves any stub, selected by STUB_KIND. Run as
 * the five services in docker-compose.test.yml. Binds 0.0.0.0 so the stub is
 * reachable both on the Compose network (internal name) and via its host port.
 */
async function main(): Promise<void> {
  const kind = process.env.STUB_KIND;
  const port = Number(process.env.PORT ?? "8080");
  const host = "0.0.0.0";

  let handle: StubHandle;
  switch (kind) {
    case "github":
      handle = await createGithubStub({ port, host });
      break;
    case "openrouter":
      handle = await createOpenRouterStub({ port, host });
      break;
    case "gloo":
      handle = await createGlooStub({ port, host });
      break;
    case "youversion":
      handle = await createYouVersionStub({ port, host });
      break;
    case "git":
      handle = await createGitServer({ port, host });
      break;
    default:
      throw new Error(
        `Unknown STUB_KIND: ${JSON.stringify(kind)} (expected github|openrouter|gloo|youversion|git)`,
      );
  }

  // eslint-disable-next-line no-console
  console.log(`[stub:${kind}] listening on ${host}:${handle.port}`);

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
