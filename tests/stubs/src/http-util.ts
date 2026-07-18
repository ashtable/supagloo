import type { IncomingMessage } from "node:http";

/**
 * Pure request helpers with no dependency on the stub-server module (keeps the
 * dependency graph acyclic).
 */

/** Buffer the full request body (binary-safe). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Compile an Express-style path template (`/app/installations/:id/tokens`) into a
 * matcher returning the captured params, or `null` when the path doesn't match.
 * `:name` captures a single non-slash segment; literal segments are escaped.
 */
export function compilePattern(
  pattern: string,
): (pathname: string) => Record<string, string> | null {
  const keys: string[] = [];
  const source =
    "^" +
    pattern
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          keys.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/") +
    "$";
  const regex = new RegExp(source);

  return (pathname: string): Record<string, string> | null => {
    const match = regex.exec(pathname);
    if (!match) return null;
    const params: Record<string, string> = {};
    keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return params;
  };
}
