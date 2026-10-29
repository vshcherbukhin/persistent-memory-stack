# docker-control — the only container that mounts the Docker socket.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/docker-control/package.json ./apps/docker-control/
RUN npm ci --workspace persistent-memory-docker-control
COPY apps/docker-control/tsconfig.json apps/docker-control/tsconfig.build.json ./apps/docker-control/
COPY apps/docker-control/src ./apps/docker-control/src
RUN npm run build -w persistent-memory-docker-control

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY apps/docker-control/package.json ./package.json
COPY --from=build /app/apps/docker-control/dist ./dist
ENV NODE_ENV=production PORT=9090
EXPOSE 9090
CMD ["node", "dist/index.js"]
