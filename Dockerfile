# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/driver/package.json apps/driver/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --workspace @corewaste/api --include-workspace-root --strict-ssl=true
COPY apps/api apps/api
RUN npm run build -w @corewaste/api
COPY database database
RUN chmod -R a+rX /app/apps/api /app/database
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm prune --omit=dev --workspace @corewaste/api --include-workspace-root --ignore-scripts --strict-ssl=true
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api apps/api
COPY --from=build /app/database database
USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node","apps/api/dist/main.js"]
