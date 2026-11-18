# Cells resolver gateway. A Node 24 service that reads names straight from a public
# CKB node and serves them over HTTP. It imports the SDK by relative path, so the build
# context is the REPO ROOT (it needs both sdk/ and services/gateway/), not this folder.
#
#   docker build -f services/gateway/Dockerfile -t comp_cells-resolver:latest .
FROM node:24-alpine
WORKDIR /app

# One @ckb-ccc/core at the root so both the SDK (in /app/sdk) and the gateway resolve it.
COPY services/gateway/package.json services/gateway/package-lock.json ./
RUN npm ci --omit=dev

# The SDK runs from source (no build step); the gateway imports ../../../sdk/src.
COPY sdk/ ./sdk/
COPY services/gateway/src/ ./services/gateway/src/

WORKDIR /app/services/gateway
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.ts"]
