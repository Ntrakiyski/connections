FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
COPY web ./web
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples
RUN npm ci --ignore-scripts
RUN npm run generate:catalog
RUN npm run build
RUN npm run build --workspace web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV OOMOL_CONNECT_DATA_DIR=/app/data
COPY package.json package-lock.json ./
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY scripts/ensure-generated.ts ./scripts/ensure-generated.ts
COPY scripts/staging-auth-rehearsal.ts ./scripts/staging-auth-rehearsal.ts
COPY scripts/staging-auth-recovery.ts ./scripts/staging-auth-recovery.ts
COPY scripts/finalize-company-schema.ts ./scripts/finalize-company-schema.ts
COPY migrations ./migrations
COPY sqlite-migrations ./sqlite-migrations
COPY --from=build /app/src ./src
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/dist ./dist

RUN npm ci --omit=dev --ignore-scripts
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
CMD ["node", "src/server/index.ts"]

FROM runtime AS staging-rehearsal
RUN apk add --no-cache postgresql16-client

FROM runtime AS production
