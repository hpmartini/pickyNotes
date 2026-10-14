FROM node:22-slim
WORKDIR /app

# claude CLI: runs with the subscription login mounted into /home/node/.claude (never an API key)
RUN npm install -g @anthropic-ai/claude-code

# workspace manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --omit=dev -w @pickynotes/server -w @pickynotes/shared

COPY packages/shared packages/shared
COPY packages/server packages/server

# model cache (multilingual-e5-small) lives in a volume so it is downloaded once
RUN mkdir -p /app/node_modules/@huggingface/transformers/.cache /vault && chown -R node:node /app/node_modules/@huggingface /vault /home/node
USER node
ENV NODE_ENV=production VAULT_PATH=/vault PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "packages/server/src/main.ts"]
