# Publicado como: weblooks/auto-clear-wahagows (Docker Hub)
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN chown -R node:node /app

ENV NODE_ENV=production
USER node

CMD ["node", "src/index.js"]
