FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
VOLUME ["/app/data"]
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "src/server.js"]
