FROM node:24.21.0-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY nodes ./nodes
COPY credentials ./credentials
RUN npm run build

FROM docker.n8n.io/n8nio/n8n:2.38.7@sha256:a8c95f75c6fdf65f5f2b7a7b354744eaa1c62bb911b5c00af6499c3f38e4cd32
COPY --from=build --chown=node:node /build/dist /opt/actionbox-custom
ENV N8N_CUSTOM_EXTENSIONS=/opt/actionbox-custom
ENV NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules
