FROM node:22-alpine AS build
WORKDIR /app
COPY web/package*.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
ENV NUXT_DXF_INTERNAL_URL=http://api:8011
ENV NUXT_TELEMETRY_DISABLED=1
RUN cd web && npm run build
FROM node:22-alpine
WORKDIR /app
ENV HOST=0.0.0.0 PORT=8010 NODE_ENV=production
COPY --from=build /app/web/.output ./.output
USER node
EXPOSE 8010
CMD ["node", ".output/server/index.mjs"]
