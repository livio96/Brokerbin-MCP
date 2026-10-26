# --- build stage ------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ----------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Render sets PORT; default for local runs.
ENV PORT=3000
ENV MCP_TRANSPORT=http
EXPOSE 3000

# Drop to the non-root user that the node image ships with.
USER node

CMD ["node", "dist/index.js"]
