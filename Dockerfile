FROM node:24.18.1-alpine3.24
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
ARG INSTALL_SING_BOX=true
RUN if [ "$INSTALL_SING_BOX" = "true" ]; then npm run install:sing-box; fi
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 OPENCODE_BRIDGE_SING_BOX_PATH=/app/vendor/sing-box/sing-box
EXPOSE 8787
VOLUME ["/app/data"]
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "src/server.js"]
