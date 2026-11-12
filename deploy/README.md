# 版本与自动部署

`package.json` 是版本号的唯一来源，实际线上版本可通过 `/api/version` 查询。提交号区分同一版本下的每次构建。

```sh
npm run version:patch  # 修复：1.1.0 → 1.1.1
npm run version:minor  # 新功能：1.1.0 → 1.2.0
npm run version:major  # 不兼容变更：1.1.0 → 2.0.0
npm run version:check
```

这些命令更新 package.json 和锁文件，不自动提交或打 tag。修改后正常提交并推送 main 即可。可选的 `vX.Y.Z` tag 必须与包版本一致，否则 CI 拒绝构建。

页面登录/建房区显示版本，`GET /api/version` 返回 `version`、`revision` 和 `builtAt`。镜像携带相同 OCI 版本/提交标签，提供 `sha-完整提交号` 及 `版本-build.CI序号` 标签；部署不使用会变化的 latest 标签。

## 生产服务器

部署路径 `/opt/werewolf`，Compose 为 `compose.yaml`，数据目录为 `data`。Caddy 独立提供 HTTPS。

`werewolf-update.timer` 每两分钟运行一次检查，首次在启动一分钟后运行。它只读取公开仓库 `magiczheng/werewolf` 的 `docker.yml` 工作流、main 分支、push 事件的最新运行，必须已结束且整体成功。失败、进行中、PR、tag、已部署或回滚过的运行不会触发切换。一次请求/两分钟以控制公开 GitHub API 请求量。

处理流程：

1. 根据完整提交 SHA 取得 GHCR 镜像，验证平台、镜像元数据、所有压缩层与解压层摘要。网络断开时分段重试并复用缓存。
2. 在临时目录生成 Docker 导入归档并导入镜像，核对最终 image ID。此时旧应用继续运行。
3. 使用 SQLite 在线备份保存账号、会话和房间数据到 `data/backups/`。
4. 原子修改 `.env` 中的 APP_IMAGE，Compose 启动新容器并等待健康检查，再核对 `/api/version` 提交号。
5. 失败则恢复旧镜像及环境文件并重新检查健康状态，记录被阻止的 CI 运行；重新运行 GitHub CI 或推送新提交后可再次部署。

更新期间会短暂断开连接，客户端会重连并从持久化存档恢复对局。数据库备份不会在应用回滚时自动覆盖，因为这可能丢弃更新期间的新数据；未来涉及不兼容数据库迁移时需单独制定迁移/回滚方案。

服务器不保存 GitHub 个人令牌，GitHub 不持有服务器登录密钥。更新器是一次性安装的运维脚本，应用镜像更新不会自动替换该脚本。

```sh
systemctl status werewolf-update.timer
systemctl list-timers werewolf-update.timer
journalctl -u werewolf-update.service -n 50 --no-pager
cat /opt/werewolf/deploy-state.json
curl -fsS https://werewolf.zhengyd.top/api/version

# 只检查，不下载和切换
python3 /opt/werewolf/deploy/auto_update.py --dry-run
# 立即检查并更新
systemctl start werewolf-update.service
# 暂停自动更新
systemctl stop werewolf-update.timer
```

下载失败不会触碰运行中的服务。临时导入归档自动清理，压缩层缓存保留当前及上一版；数据库备份及 Docker 历史镜像不自动删除，应按业务留存要求定期检查磁盘。

首次安装：将 `auto_update.py` 放到 `/opt/werewolf/deploy/`，将两个 systemd 文件放到 `/etc/systemd/system/`，在 `deploy-state.json` 写入当前 revision 以避免旧版重复部署，然后执行 `systemctl daemon-reload && systemctl enable --now werewolf-update.timer`。服务器须有 Docker、Compose、Python 3，且当前 app/data 目录属于 UID 1000。更新器按当前 amd64 服务器部署。
