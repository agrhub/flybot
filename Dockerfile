# CamHub: one image for Cloud Run and the Compute Engine VM.
# The server (server/dist/app.js) serves both the API and the built Vue client.

# ---------- Build stage ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci

COPY client client
COPY server server

# Google Maps browser key is baked into the client bundle at build time (it is public by nature;
# restrict it to your domains in Google Cloud Console)
ARG VITE_GOOGLE_MAP_KEY=""
ENV VITE_GOOGLE_MAP_KEY=${VITE_GOOGLE_MAP_KEY}

# Builds client, bundles server and copies client assets into server/dist
RUN npm run build

# ---------- Runtime stage ----------
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Cloud Run sets PORT itself; this is the default elsewhere
ENV PORT=8080

COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci --omit=dev --workspace=server && npm cache clean --force

COPY --from=build /app/server/dist server/dist

USER node
EXPOSE 8080
CMD ["node", "server/dist/app.js"]
