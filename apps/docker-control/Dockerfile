# docker-control — the only container that mounts the Docker socket.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/docker-control/package.json ./apps/docker-control/
RUN npm ci --workspace persistent-memory-docker-control
COPY apps/docker-control/tsconfig.json apps/docker-control/tsconfig.build.json ./apps/docker-control/
COPY apps/docker-control/src ./apps/docker-control/src
RUN npm run build -w persistent-memory-docker-control

FROM node:22-alpine
WORKDIR /app
COPY apps/docker-control/package.json ./package.json
COPY --from=build /app/apps/docker-control/dist ./dist
ENV NODE_ENV=production PORT=9090
EXPOSE 9090
CMD ["node", "dist/index.js"]
