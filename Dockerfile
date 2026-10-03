# syntax=docker/dockerfile:1
#
# web-lite-tabletop-sim —— 生产镜像
#
# 设计取舍：
#   · **单阶段**。项目零构建（原生 <script>，无打包器），
#     所以不需要 builder 阶段；多阶段只会平白多一层复杂度。
#   · `node:22-alpine`。唯一的依赖 `ws` 没有原生模块，
#     alpine 够用，镜像约 70MB（debian 版约 130MB）。
#   · **直接 `node server/index.js`，不经过 npm**。
#     npm 当 PID 1 会吞掉 SIGTERM —— 那样容器 stop 时
#     进程被 SIGKILL，5 秒防抖窗口里没落盘的改动直接丢。
#   · 非 root 运行。
#
# 镜像里**不含贴图**（仓库就不含）。要让棋盘有图，
# 见 README「资产」一节，或用 volumes 挂载 public/assets。

FROM node:22-alpine

# tini 收 SIGTERM/SIGCHLD 并转发。node 直接当 PID 1 时
# 信号处理有边界情况（PID 1 不套用默认信号处置），
# 用一个极小的 init 最省心。
RUN apk add --no-cache tini

WORKDIR /app

# 依赖先装：只要 package.json/lock 没变，这层就能命中缓存。
# --omit=dev 去掉 devDependencies；项目其实一个 dev 依赖都没有。
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 源码。零构建，直接拷。
#
# **用 `--chown` 而不是事后再 `chown -R`**：chown 会改写每个文件的
# 元数据，等于把整棵树复制成新的一层（实测多出 17.7MB）。
# `COPY --chown` 在拷贝时就设好属主，不多占一层。
COPY --chown=node:node server/ ./server/
COPY --chown=node:node public/ ./public/

# 数据目录：唯一需要持久化的东西（房间元数据 + 盘面快照）。
# 声明 VOLUME 让使用者知道要挂；不挂的话数据会随容器消失。
# 这个目录是空的，chown 它不产生额外层。
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

EXPOSE 3000

# 健康检查：编排（compose/k8s）靠它判断存活。
# 用 node 自己的 http 发请求，避免为了 wget/curl 再装一个包。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
