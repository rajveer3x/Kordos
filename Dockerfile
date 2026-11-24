FROM node:24-bookworm-slim AS build
WORKDIR /build
RUN npm install --global pnpm@10.34.9
COPY . .
RUN pnpm install --frozen-lockfile

FROM build AS web-build
RUN pnpm build

FROM nginx:1.28-alpine AS web
COPY --from=web-build /build/apps/web/dist /usr/share/nginx/html
COPY infra/deploy/default.conf.template /etc/nginx/templates/default.conf.template
ENV KORDOS_API_UPSTREAM=http://api:4301

FROM build AS api-build
RUN pnpm --filter @kordos/api --prod deploy --legacy /release

FROM build AS worker-build
RUN pnpm --filter @kordos/worker --prod deploy --legacy /release

FROM build AS migrate-build
RUN pnpm --filter @kordos/db --prod deploy --legacy /release

FROM node:24-bookworm-slim AS server
WORKDIR /app
ENV NODE_ENV=production
USER node

FROM server AS api
COPY --from=api-build --chown=node:node /release/ ./
ENV API_HOST=0.0.0.0
EXPOSE 4301
CMD ["node", "--import", "tsx", "src/index.ts"]

FROM server AS worker
COPY --from=worker-build --chown=node:node /release/ ./
CMD ["node", "--import", "tsx", "src/index.ts"]

FROM server AS migrate
COPY --from=migrate-build --chown=node:node /release/ ./
CMD ["node", "--import", "tsx", "src/migrate.ts"]
