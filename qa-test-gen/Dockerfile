# AAQUA backend image — Express + Playwright. NO nginx, NO supervisord, NO SPA.
# The SPA is built in stage 1 and EXPORTED to a host volume by scripts/publish-spa.sh.
# The shared-infra nginx serves the SPA and reverse-proxies to this container's :3001.

# ─── Stage 1: build the React SPA ─────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src

ARG VITE_LLM_API_KEY=server-injected
ARG VITE_LLM_ENDPOINT=https://llm.lab.aaseya.com/v1
ARG VITE_LLM_MODEL=gpt-oss-20b
ARG VITE_KEYCLOAK_URL=https://aaqua.aaseya.com:8443/auth
ARG VITE_KEYCLOAK_REALM=aaseya-platform
ARG VITE_KEYCLOAK_CLIENT_ID=aaqua-frontend
ARG VITE_BASE_PATH=/aaqua/
ENV VITE_LLM_API_KEY=$VITE_LLM_API_KEY \
    VITE_LLM_ENDPOINT=$VITE_LLM_ENDPOINT \
    VITE_LLM_MODEL=$VITE_LLM_MODEL \
    VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL \
    VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM \
    VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID \
    VITE_BASE_PATH=$VITE_BASE_PATH

RUN npm run build

# ─── Stage 2: backend production deps ─────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.0-jammy AS backend-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ─── Stage 3: final backend runtime ───────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.0-jammy

RUN apt-get update && \
    apt-get install -y --no-install-recommends openjdk-17-jdk maven && \
    npx playwright install chrome && \
    for path in "/opt/google/chrome/chrome" "/opt/google/chrome/google-chrome" "/usr/bin/google-chrome" "/usr/bin/google-chrome-stable"; do \
        if [ -f "$path" ] && [ ! -L "$path" ]; then \
            mv "$path" "${path}-original" && \
            echo '#!/bin/bash' > "$path" && \
            echo "exec ${path}-original --no-sandbox --disable-dev-shm-usage --headless=new \"\$@\"" >> "$path" && \
            chmod +x "$path"; \
        fi; \
    done && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
RUN mkdir -p temp_uploads temp_extract temp_output

EXPOSE 3001
# tini is provided by `init: true` in docker-compose.yml so we don't install it here.
ENTRYPOINT ["node", "server/index.js"]
