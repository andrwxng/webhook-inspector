# Build with dev tooling (tsc, vite), ship a slim runtime image.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev
# The backend serves ../../frontend/dist relative to backend/dist —
# preserve the workspace layout. Migrations are embedded in the JS,
# so dist is self-contained.
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist
USER node
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
