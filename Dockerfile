FROM node:24.19.0-alpine3.24
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package*.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node . .
ARG INSTALL_SING_BOX=true
ARG OPENCODE_BRIDGE_SING_BOX_VERSION=1.13.16
ARG OPENCODE_BRIDGE_SING_BOX_FLAVOR
ARG OPENCODE_BRIDGE_SING_BOX_DOWNLOAD_URL
ARG OPENCODE_BRIDGE_SING_BOX_SHA256
RUN if [ "$INSTALL_SING_BOX" = "true" ]; then npm run install:sing-box; fi
RUN mkdir -p /app/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 OPENCODE_BRIDGE_SING_BOX_PATH=/app/vendor/sing-box/sing-box
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:8787/livez || exit 1
CMD ["node", "src/server.js"]
