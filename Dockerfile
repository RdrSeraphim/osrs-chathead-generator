FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build

RUN mkdir -p /app/cache && chown -R node:node /app

ENV NODE_ENV=production

USER node

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/api/cache/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
