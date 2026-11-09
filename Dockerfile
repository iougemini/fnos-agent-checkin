FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--experimental-sqlite \
    PORT=8787 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

ARG NPM_REGISTRY=https://registry.npmmirror.com

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="${NPM_REGISTRY}"

COPY src ./src

RUN mkdir -p /data
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
