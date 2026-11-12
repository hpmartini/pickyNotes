# Bun is the package manager only; the runtime stays Node (claude CLI, @hono/node-server and onnxruntime-node are Node programs, pg is untested under Bun).
FROM oven/bun:1.4.4 AS bun
FROM node:22-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# claude CLI: runs with the subscription login mounted into /home/node/.claude (never an API key)
RUN npm install -g @anthropic-ai/claude-code

# workspace manifests first for layer caching
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY apps/desktop/package.json apps/desktop/
RUN bun install --frozen-lockfile --production --filter @pickynotes/server --filter @pickynotes/shared

COPY packages/shared packages/shared
COPY packages/server packages/server

# model cache (multilingual-e5-small) lives in a volume so it is downloaded once
RUN mkdir -p /models /vault && chown -R node:node /models /vault /home/node
USER node
ENV NODE_ENV=production VAULT_PATH=/vault PORT=8787 MODEL_CACHE_DIR=/models
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "packages/server/src/main.ts"]
