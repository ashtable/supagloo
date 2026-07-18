-- Runs once, on first Postgres startup, from /docker-entrypoint-initdb.d.
--
-- POSTGRES_DB is pinned to `postgres` in docker-compose.yml, so the image does
-- NOT auto-create either of these — this script is the single source of truth
-- for both logical databases. Both statements are therefore unconditional.
--
--   supagloo       : application schema, managed by Prisma (database-lib).
--   supagloo_dbos   : DBOS system database (durable workflow checkpoints/queues).

CREATE DATABASE supagloo;
CREATE DATABASE supagloo_dbos;
