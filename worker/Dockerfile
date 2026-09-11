FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY shared/package.json ./shared/
COPY worker/package.json ./worker/
RUN npm install --ignore-scripts
COPY shared ./shared
COPY worker ./worker
RUN npx tsc -b worker

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# ONNX MiniLM weights are downloaded on first boot and cached here, so the
# embedding path costs nothing and works with the network unplugged after.
ENV MODEL_CACHE_DIR=/app/.models
RUN addgroup -S app && adduser -S app -G app && mkdir -p /app/.models && chown app:app /app/.models
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/worker/dist ./worker/dist
COPY --from=build /app/worker/package.json ./worker/
COPY --from=build /app/package.json ./
USER app
CMD ["node", "worker/dist/index.js"]
