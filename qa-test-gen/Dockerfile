# AAQUA bundled image — frontend (nginx) + backend (Express + Playwright)
# in a single container, supervised by supervisord.
#
# Layout inside the running container:
#   :80   nginx     serves the React SPA, proxies /api → 127.0.0.1:3001,
#                   proxies /llm-api → https://llm.lab.aaseya.com (Authorization
#                   header injected from /run/secrets/llm_api_key).
#   :3001 node      Express + Playwright, bound to localhost only — never
#                   published to the host. All inbound traffic hits nginx first.
#
# Build:    docker compose build app
# Run:      docker compose up -d app

# ─── Stage 1: build the React SPA ────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src

# A non-empty sentinel keeps the frontend's `if (!API_KEY) throw` check happy.
# The real key never ships in the bundle — nginx injects it on /llm-api requests.
ARG VITE_LLM_API_KEY=server-injected
ARG VITE_LLM_ENDPOINT=https://llm.lab.aaseya.com/v1
ARG VITE_LLM_MODEL=gpt-oss-20b
ENV VITE_LLM_API_KEY=$VITE_LLM_API_KEY \
    VITE_LLM_ENDPOINT=$VITE_LLM_ENDPOINT \
    VITE_LLM_MODEL=$VITE_LLM_MODEL

RUN npm run build

# ─── Stage 2: install backend production deps ────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.0-jammy AS backend-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ─── Stage 3: final bundled runtime ──────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.0-jammy

ENV NODE_ENV=production \
    PORT=3001 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DEBIAN_FRONTEND=noninteractive

# nginx (web tier) + supervisor (process supervision) +
# gettext-base (envsubst for secret injection into nginx.conf) +
# tini (PID 1, clean signal forwarding).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        nginx \
        supervisor \
        gettext-base \
        tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f  /etc/nginx/sites-enabled/default

WORKDIR /app

# Backend code + production deps (Playwright browsers already in the base image).
COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
RUN mkdir -p temp_uploads temp_extract temp_output

# Frontend static bundle.
COPY --from=frontend-build /app/dist /var/www/aaqua

# nginx config template, supervisord config, and the entrypoint that wires
# Docker secrets into env vars + renders the nginx config.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/supervisord.conf    /etc/supervisor/supervisord.conf
COPY docker/app-entrypoint.sh   /usr/local/bin/app-entrypoint.sh
RUN chmod +x /usr/local/bin/app-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/app-entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf"]
