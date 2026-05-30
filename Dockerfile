FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared ./packages/shared
COPY apps/server/package*.json ./apps/server/
COPY apps/worker/package*.json ./apps/worker/
RUN npm ci --no-audit --no-fund \
  && npm ci --prefix packages/shared --no-audit --no-fund \
  && npm ci --prefix apps/server --install-links --no-audit --no-fund \
  && npm ci --prefix apps/worker --install-links --no-audit --no-fund

COPY . .
CMD ["npm", "run", "start:server"]
