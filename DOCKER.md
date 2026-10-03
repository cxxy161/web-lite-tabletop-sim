# Docker 部署

## 最快路径

```bash
git clone <this-repo>
cd web-lite-tabletop-sim
docker compose up -d
```

打开 `http://<你的IP>:3222`。

> **端口**：容器内是 3000，映射到宿主机的 **3222**。
> 想换：`HOST_PORT=8080 docker compose up -d`。

---

## ⚠️ 贴图不在仓库里

镜像里**没有贴图**（1003 张 WebP，13MB，版权与体积原因）。
直接 `up` 起来能用，但棋盘上的棋子是空白的 —— 骰子和标记不受影响。

要真实的《大洋落日》盘面，**在 build 之前**跑一次资产管线：

```bash
# 1. 把创意工坊模组（Workshop ID 3636541733）的资产包放好
#    命名为「大洋落日_资产.zip」，放在仓库根目录
# 2. 生成贴图
python3 -m pip install pillow
python3 tools/build_assets.py
# 3. 然后构建，贴图会被打进镜像
docker compose up -d --build
```

`.dockerignore` **不排除** `public/assets/`，所以已生成的贴图会进镜像。
（它排除的是那个 254MB 的原始 zip —— 不排的话每次构建都要把它
整个发给 docker daemon。）

**换模组/换贴图不必重建镜像**：取消 `docker-compose.yml` 里
那行 `./public/assets:/app/public/assets:ro` 的注释，运行时挂载即可。

---

## 数据持久化

房间元数据与盘面快照都在 `/app/data`，挂在一个**命名卷**里：

```bash
docker volume ls | grep tabletop          # web-tts_tabletop-data
docker compose exec tabletop ls -la /app/data
docker compose exec tabletop cat /app/data/rooms.json
```

> **备份**：
> ```bash
> docker run --rm -v web-tts_tabletop-data:/d -v "$PWD:/out" alpine \
>   tar czf /out/tabletop-backup.tar.gz -C /d .
> ```

想用宿主机的目录（方便直接看文件）就把 compose 里的
`tabletop-data:/app/data` 换成 `./data:/app/data`，
但**要先把目录 chown 成 1000:1000**（容器以非 root 运行）：

```bash
mkdir -p data && sudo chown -R 1000:1000 data
```

---

## 配置

复制 `.env.example` 为 `.env` 后按需改：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST_PORT` | `3222` | 宿主机端口 |
| `TZ` | `Asia/Shanghai` | 时区（只影响日志时间） |
| `BOARD_IDLE_MS` | `600000` | 盘面在内存里空闲多久卸载。**弱服务器调小**（如 `120000`） |

---

## 加 HTTPS（可选）

真机测试时浏览器有些 API 要求 HTTPS；而且没有 HTTPS 时
身份 token 在局域网里可被嗅探。

```bash
# .env 里写你的域名
echo 'SITE_ADDRESS=table.example.com' >> .env
docker compose --profile tls up -d
```

Caddy 会自动申请并续期证书。**WebSocket 不用额外配置** —— 本项目把
WS 挂在 http server 的 `/ws` 上（同一个端口），Caddy 的 `reverse_proxy`
默认就处理 Upgrade 头。

> `Caddyfile` 里给 WS 设了 `read_timeout 0` / `write_timeout 0`：
> 手机锁屏时客户端心跳会停，不该让反代把长连接掐掉。
>
> 另外**访问日志会记下 WS 查询串里的 token**（`/ws?...&token=xxx`）。
> 自建自用可以接受；在意就在 `Caddyfile` 里把 `log` 块关掉。

---

## 反向代理（已有 nginx / 别的）

不用 Caddy 的话，任何反代都行。要点：

- **转发 `/ws`，并允许 Upgrade**（WebSocket 与 HTTP 同端口）
- WS 连接要设**长超时**（本项目 30s 一次心跳，但手机后台会停）
- 客户端用的是**相对地址**（`location.host + '/ws'`），所以
  子路径部署也能用 —— 但要保证 `/api/*`、`/assets/*`、`/scenes/*`
  都在同一前缀下

nginx 例子：

```nginx
location / {
    proxy_pass http://127.0.0.1:3222;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;      # WebSocket 是长连接
    proxy_send_timeout 3600s;
    client_max_body_size 16m;      # 导入存档（base64 约 90KB，留足余量）
}
```

---

## 运维

```bash
docker compose logs -f tabletop      # 日志
docker compose restart tabletop      # 重启
docker compose down                  # 停（保留卷）
docker compose down -v               # 停并**删除数据**（危险）
docker compose up -d --build         # 改代码后重建
```

**健康检查**：镜像内置 `HEALTHCHECK`，打 `/api/health`。
`docker compose ps` 会显示 `(healthy)`。

**退出**：容器用 `tini` 当 PID 1，`docker stop` 的 SIGTERM 会被正确转发给 node，
触发落盘后退出。

> ⚠️ **可能丢最多 5 秒的改动**。落盘是异步的、5 秒防抖，而退出只等 300ms。
> 实测：发出一个操作后立刻 `stop`，那个操作不会在盘上。
> 「不怎么 stop」的场景可以接受；要严格保证见 `agent.md` §12。

**内存**：很省。单个 778 枚棋子的房间约 **0.36MB**，
30 个房间约 10MB。`BOARD_IDLE_MS` 到期的房间会从内存卸载
（**不删数据**，下次有人进自动读回来）。

---

## 排障

| 症状 | 原因 |
|---|---|
| 棋盘空白、棋子位置对但没图 | 贴图没打进镜像，见上 |
| `address already in use` | 宿主机端口被占。`HOST_PORT=8080 docker compose up -d` |
| 手机连不上 | 用**内网 IP** 而不是 `localhost`；检查防火墙放行端口 |
| 页面能开但一直「重连中」 | 反代没转发 `/ws` 或没允许 Upgrade |
| 数据不见了 | 用了 `down -v`（删卷），或没挂载数据卷 |
| `permission denied` 写 data | 绑定挂载的目录没 chown 成 1000:1000 |

看容器里的实时状态：

```bash
curl -s localhost:3222/api/health | python3 -m json.tool
# {"ok":true,"uptime":…,"rooms":…,"boards":…,"clients":…,"mem":…}
```
