# syntax=docker/dockerfile:1
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/update-runner/package.json ./apps/update-runner/
RUN npm ci --workspace persistent-memory-update-runner
COPY tsconfig.base.json ./
COPY apps/update-runner/tsconfig.json apps/update-runner/tsconfig.build.json ./apps/update-runner/
COPY apps/update-runner/src ./apps/update-runner/src
COPY layers/update-ops ./layers/update-ops
RUN npm run build -w persistent-memory-update-runner

FROM node:22-alpine AS runtime-deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/update-runner/package.json ./apps/update-runner/
RUN npm ci --omit=dev --workspace persistent-memory-update-runner

FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache bash coreutils docker-cli docker-cli-compose git openssh-client postgresql17-client
COPY apps/update-runner/package.json ./package.json
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/update-runner/dist ./dist
EXPOSE 9092
CMD ["node", "dist/apps/update-runner/src/index.js"]
