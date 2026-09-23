# Backrooms VR (fiche projet étape 8). Un seul service au final : le serveur Node sert
# à la fois le build statique du front (SPA) et l'API de classement (étape 7) — plus
# simple à exposer (un seul port) qu'un couple de conteneurs front/API séparés.

FROM node:22-slim AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-slim AS server-deps
WORKDIR /app/server
# better-sqlite3 : binaire précompilé la plupart du temps, ces outils ne servent qu'en repli.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/src ./src
COPY src/shared /app/src/shared
COPY --from=frontend-build /app/dist /app/dist

EXPOSE 8787
CMD ["node_modules/.bin/tsx", "src/server.ts"]
