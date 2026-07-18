import { S3Client } from "@aws-sdk/client-s3";

/**
 * Canonical local-dev connection config for the Compose stack, and the single
 * source of truth the smoke tests import. Every value reads from an env var
 * (the documented scheme in `.env.example`) with a fallback to the compose
 * default, so the suite runs out-of-the-box against `docker compose up`.
 */

const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = Number(process.env.PGPORT ?? "5432");
const PG_USER = process.env.POSTGRES_USER ?? "supagloo";
const PG_PASSWORD = process.env.POSTGRES_PASSWORD ?? "supagloo";

export const PG = {
  host: PG_HOST,
  port: PG_PORT,
  user: PG_USER,
  password: PG_PASSWORD,
  /** Prisma-managed application database. */
  appDb: "supagloo",
  /** DBOS system database (checkpoints/queues). */
  dbosDb: "supagloo_dbos",
  appUrl:
    process.env.DATABASE_URL ??
    `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/supagloo`,
  dbosUrl:
    process.env.DBOS_DATABASE_URL ??
    `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/supagloo_dbos`,
} as const;

export const S3 = {
  /** Host-reachable endpoint — used to SIGN presigned URLs a host client fetches. */
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
  /** Internal Docker-network endpoint — server-side/container-to-container ops. */
  internalEndpoint: process.env.S3_ENDPOINT ?? "http://minio:9000",
  bucket: process.env.S3_BUCKET ?? "supagloo-dev",
  accessKey: process.env.S3_ACCESS_KEY ?? "supagloo",
  secretKey: process.env.S3_SECRET_KEY ?? "supagloo-dev",
  region: process.env.S3_REGION ?? "us-east-1",
} as const;

export const API = {
  /** Host-reachable base URL of the Fastify API (Compose maps 4000:4000). */
  baseUrl: process.env.API_BASE_URL ?? "http://localhost:4000",
} as const;

/**
 * Build an S3 client for MinIO. Defaults to the PUBLIC (host-reachable)
 * endpoint because the tests run on the host; `forcePathStyle` is mandatory for
 * MinIO (no vhost-style bucket DNS).
 */
export function makeS3Client(endpoint: string = S3.publicEndpoint): S3Client {
  return new S3Client({
    endpoint,
    region: S3.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3.accessKey,
      secretAccessKey: S3.secretKey,
    },
  });
}
