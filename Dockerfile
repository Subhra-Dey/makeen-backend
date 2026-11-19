# syntax=docker/dockerfile:1
# MAKEEN FM Portal — API image (deployed to its own server).
# Self-contained: build from THIS folder.
#   docker build -t makeen-api .                      → runtime image (node dist/main.js)
#   docker build --target migrate -t makeen-api-migrate .  → one-off migration job
#     (run it BEFORE starting a new API version: it applies prisma/migrations with
#      MIGRATE_DATABASE_URL = the schema owner; see docs/DEPLOYMENT.md)
ARG NODE_IMAGE=node:24.22.3-alpine

# 1) All dependencies. `npm ci` runs `prisma generate`, so the schema must be present first.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit

# 2) Migration job: Prisma CLI + committed SQL migrations only.
FROM deps AS migrate
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# 3) Build: compile, then drop dev dependencies.
FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

# 4) Runtime: production deps + compiled code only, non-root.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --chown=node:node start.sh ./start.sh
RUN chmod +x ./start.sh
USER node
EXPOSE 10000 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./start.sh"]
