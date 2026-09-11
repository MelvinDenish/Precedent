# Multi-stage: the runtime image carries no toolchain and no source.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
RUN npm ci --omit=dev --ignore-scripts || npm install --ignore-scripts
COPY shared ./shared
COPY api ./api
RUN npx tsc -b api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/package.json ./api/
COPY --from=build /app/package.json ./
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "api/dist/index.js"]
