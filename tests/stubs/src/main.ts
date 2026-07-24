import { createGithubStub } from "./github-stub";
import { createGitServer } from "./git-server";
import type { StubHandle } from "./stub-server";

/**
 * Container entrypoint: one image serves any stub, selected by STUB_KIND. Run as
 * the two services in docker-compose.test.yml (github-stub + git-server). Task
 * 34-E8 (design-delta §10.7) removed the openrouter/gloo/youversion kinds — those
 * providers are now exercised for real by the backend e2e suites. Binds 0.0.0.0 so
 * the stub is reachable both on the Compose network (internal name) and via its host
 * port.
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
    case "git":
      handle = await createGitServer({ port, host });
      break;
    default:
      throw new Error(
        `Unknown STUB_KIND: ${JSON.stringify(kind)} (expected github|git)`,
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
