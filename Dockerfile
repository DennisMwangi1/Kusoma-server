# Kusoma-server — production image for Dokploy (and any Docker host).
#
# Dokploy:
#   Build type     = Dockerfile
#   Dockerfile     = ./Dockerfile
#   Context        = .   (this directory / the Kusoma-server repo root)
#   Port           = 3000
#   Health check   = GET /health  (HEALTHCHECK is in this file)
#
# Required env (set in Dokploy → Environment, not baked into the image):
#   DATABASE_URL    postgres://…  (add ?sslmode=require for managed Postgres)
#   JWT_SECRET
# Optional:
#   PORT            default 3000
#   DATABASE_CA_CERT, DATABASE_POOL_MAX
#   TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, BACKEND_URL
#   CBC_API_URL, CBC_API_KEY
#   ANTHROPIC_API_KEY, ANTHROPIC_MODEL  (default claude-sonnet-5)
#
# On every start the entrypoint runs drizzle migrate + idempotent seed, then
# `node dist/index.js`.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh \
  && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
