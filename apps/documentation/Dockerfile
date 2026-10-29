# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS assets
WORKDIR /app
COPY apps/documentation/package.json apps/documentation/package-lock.json apps/documentation/.npmrc ./
RUN npm ci --ignore-scripts

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS navigation
WORKDIR /workspace
COPY mkdocs.template.yml ./
COPY documentation ./documentation
COPY apps/documentation/scripts/generate-mkdocs-config.mjs ./apps/documentation/scripts/generate-mkdocs-config.mjs
RUN node apps/documentation/scripts/generate-mkdocs-config.mjs

FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159 AS builder
WORKDIR /workspace
COPY documentation/requirements.lock documentation/build-requirements.lock ./documentation/
RUN python3 -m pip install --disable-pip-version-check --no-cache-dir \
    --require-hashes -r documentation/build-requirements.lock \
    && python3 -m pip install --disable-pip-version-check --no-cache-dir \
    --no-build-isolation --require-hashes -r documentation/requirements.lock \
    && python3 -m pip check
COPY --from=navigation /workspace/mkdocs.yml ./
COPY --from=navigation /workspace/documentation ./documentation
RUN python3 -m mkdocs build --site-dir /site
COPY --from=assets /app/node_modules/mermaid/dist/mermaid.min.js \
    /site/assets/javascripts/mermaid.min.js

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    HOSTNAME=0.0.0.0 \
    DOCUMENTATION_SITE_DIR=/site \
    DOCUMENTATION_VERSION=2.0.0
COPY apps/documentation/package.json ./package.json
COPY apps/documentation/src ./src
COPY --from=builder /site /site
USER node
EXPOSE 8000
CMD ["node", "src/server.mjs"]
