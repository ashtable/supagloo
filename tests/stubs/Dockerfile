# Test-only provider-stub image (Task #9). One image serves any stub via
# STUB_KIND. node:22-slim + git (the git-server mode shells out to
# git-http-backend). NEVER built by a plain `docker compose up` — only the
# explicitly-invoked docker-compose.test.yml overlay references it.
FROM node:22-slim

# git for the smart-HTTP server (git-http-backend + init/commit for seeding).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# tsx runs the TypeScript stubs directly (no build step).
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY src ./src

ENV PORT=8080
EXPOSE 8080

# Global fetch (Node 22) drives the readiness probe against each stub's
# /__stub/health introspection route.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=20 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/__stub/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/main.ts"]
