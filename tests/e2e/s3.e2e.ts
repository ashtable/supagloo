import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3, makeS3Client } from "../support/dev-config";

/**
 * E2E: full S3 round-trip against the live MinIO container, including a
 * presigned GET URL SIGNED against the host-reachable endpoint
 * (`S3_PUBLIC_ENDPOINT` = localhost:9000) and CONSUMED from the host via plain
 * fetch(). This is the dual-endpoint gotcha: a URL signed against the internal
 * `minio:9000` address would be unreachable/invalid from the host.
 *
 * The test runs on the host, so it uses the public endpoint for every op.
 */
describe("Compose MinIO: S3 round-trip + host-signed presigned URL", () => {
  const s3 = makeS3Client(S3.publicEndpoint);
  const key = `smoke/roundtrip-${randomUUID()}.txt`;
  const body = `supagloo-smoke-${randomUUID()}`;

  afterAll(async () => {
    await s3
      .send(new DeleteObjectCommand({ Bucket: S3.bucket, Key: key }))
      .catch(() => {});
    s3.destroy();
  });

  it("puts an object into the supagloo-dev bucket", async () => {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: S3.bucket,
        Key: key,
        Body: body,
        ContentType: "text/plain",
      }),
    );
    expect(res.$metadata.httpStatusCode).toBe(200);
  });

  it("presigns a GET URL against the host-reachable endpoint (localhost:9000)", async () => {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3.bucket, Key: key }),
      { expiresIn: 60 },
    );
    expect(new URL(url).host).toBe("localhost:9000");
    expect(url).toContain("X-Amz-Signature");
  });

  it("fetches the presigned URL from the host and round-trips the content", async () => {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: S3.bucket, Key: key }),
      { expiresIn: 60 },
    );
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe(body);
  });

  it("rejects an UNSIGNED fetch of the same object (bucket is private)", async () => {
    const unsigned = `${S3.publicEndpoint}/${S3.bucket}/${key}`;
    const res = await fetch(unsigned);
    // Proves the presigned signature is what authorizes access.
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});
