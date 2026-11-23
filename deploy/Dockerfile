# PUIMS application image (used by deploy/compose.yaml).
FROM node:22-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && chown -R node:node /app/.next
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
USER node
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
