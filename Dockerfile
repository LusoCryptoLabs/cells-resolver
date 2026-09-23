# The Cells resolver: reads .cell names straight from a public CKB node and serves them
# over HTTP, every answer with the proof to check it. Build and run it yourself:
#
#   docker build -t cells-resolver .
#   docker run -e CKB_NETWORK=mainnet -p 8787:8787 cells-resolver
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.ts"]
