# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/update-runner/package.json ./apps/update-runner/
RUN npm ci --workspace persistent-memory-update-runner
COPY tsconfig.base.json ./
COPY apps/update-runner/tsconfig.json apps/update-runner/tsconfig.build.json ./apps/update-runner/
COPY apps/update-runner/src ./apps/update-runner/src
COPY layers/update-ops ./layers/update-ops
COPY scripts/github-releases.mjs scripts/github-releases.d.mts ./scripts/
RUN npm run build -w persistent-memory-update-runner

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime-deps

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/update-runner/package.json ./apps/update-runner/
RUN npm ci --omit=dev --workspace persistent-memory-update-runner

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

WORKDIR /app
RUN apk add --no-cache bash coreutils docker-cli docker-cli-compose git openssh-client postgresql17-client
COPY apps/update-runner/package.json ./package.json
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/update-runner/dist ./dist
EXPOSE 9092
CMD ["node", "dist/apps/update-runner/src/index.js"]
