FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/echo.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY --chown=node:node . .
RUN npm run build \
    && mkdir -p /app/data \
    && chown -R node:node /app/data

VOLUME ["/app/data"]
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
