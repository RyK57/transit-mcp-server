# Build stage: compile TypeScript with dev dependencies available.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and compiled output only.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Bind to all interfaces so the platform's router can reach the container.
# MCP_PATH_SECRET is mandatory in this mode; the server refuses to start without it.
ENV TRANSPORT=http
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Drop root.
USER node

CMD ["node", "dist/index.js"]
