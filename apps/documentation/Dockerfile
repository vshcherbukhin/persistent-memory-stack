# syntax=docker/dockerfile:1

FROM node:22-alpine AS assets
WORKDIR /app
COPY apps/documentation/package.json apps/documentation/package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:22-alpine AS navigation
WORKDIR /workspace
COPY mkdocs.template.yml ./
COPY documentation ./documentation
COPY apps/documentation/scripts/generate-mkdocs-config.mjs ./apps/documentation/scripts/generate-mkdocs-config.mjs
RUN node apps/documentation/scripts/generate-mkdocs-config.mjs

FROM python:3.12-slim AS builder
WORKDIR /workspace
COPY documentation/requirements.txt ./documentation/requirements.txt
RUN python3 -m pip install --disable-pip-version-check --no-cache-dir \
    -r documentation/requirements.txt
COPY --from=navigation /workspace/mkdocs.yml ./
COPY --from=navigation /workspace/documentation ./documentation
RUN python3 -m mkdocs build --site-dir /site
COPY --from=assets /app/node_modules/mermaid/dist/mermaid.min.js \
    /site/assets/javascripts/mermaid.min.js

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    HOSTNAME=0.0.0.0 \
    DOCUMENTATION_SITE_DIR=/site \
    DOCUMENTATION_VERSION=0.2.8
COPY apps/documentation/package.json ./package.json
COPY apps/documentation/src ./src
COPY --from=builder /site /site
USER node
EXPOSE 8000
CMD ["node", "src/server.mjs"]
