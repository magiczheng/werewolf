# 狼人杀 · 聚会助手
#
# 分两阶段构建：better-sqlite3 是原生模块，若目标平台没有预编译二进制就会现场编译，
# 需要 python3 / make / g++。把这些工具留在构建阶段，运行镜像里不带编译工具链。

# ---------- 构建阶段：装依赖（必要时编译原生模块） ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# 仅在拿不到 better-sqlite3 预编译包时才会真正用到这套工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# 先只拷依赖清单：源码改动不会让这一层缓存失效
COPY package.json package-lock.json ./
# 产物不需要开发依赖（socket.io-client 只在测试里用）
RUN npm ci --omit=dev && npm cache clean --force

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production
# 数据落在 /app/data，compose 会把它挂到宿主机（见 docker-compose.yml）
ENV DB_PATH=/app/data/werewolf.db
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 用镜像自带的非 root 用户 node(uid 1000)。
# 注意：宿主机上的 ./data 需要 uid 1000 可写，否则容器起不来——
# Linux 下先执行 `mkdir -p data && sudo chown -R 1000:1000 data`。
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

# 健康检查走应用自己的接口，比只看端口开着更实在
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
