FROM node:22-bookworm-slim

WORKDIR /app

COPY bot/package.json bot/tsconfig.json ./
RUN npm install

COPY bot/src ./src
RUN npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
