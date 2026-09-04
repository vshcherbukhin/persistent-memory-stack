# dashboard-gateway — stable localhost front door for the dashboard.
# Compile TypeScript before it enters the tiny runtime image: native type
# stripping does not catch invalid names or other static type errors.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard-gateway/package.json ./apps/dashboard-gateway/
RUN npm ci --workspace persistent-memory-dashboard-gateway
COPY apps/dashboard-gateway/tsconfig.json apps/dashboard-gateway/tsconfig.build.json ./apps/dashboard-gateway/
COPY apps/dashboard-gateway/src ./apps/dashboard-gateway/src
RUN npm run build -w persistent-memory-dashboard-gateway

FROM node:22-alpine
WORKDIR /app
COPY apps/dashboard-gateway/package.json ./package.json
COPY --from=build /app/apps/dashboard-gateway/dist ./dist
ENV NODE_ENV=production PORT=3200 DASHBOARD_BASE_URL=http://persistent-memory-dashboard:3000 HANDOFF_STATE_PATH=/run/persistent-memory/update-coordinator-state/dashboard-handoff.json LEGACY_HANDOFF_STATE_PATH=/run/persistent-memory/update-state/dashboard-handoff.json
EXPOSE 3200
CMD ["node", "dist/index.js"]
