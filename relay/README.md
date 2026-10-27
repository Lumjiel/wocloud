# wocloud-relay —— 凭证中转 + token 保活

> 解决的问题：联通云盘 `exchange` 续期会**立刻作废旧 token**（2026-10-26 实测 3/3），多台设备各自续期会互相踢掉。
> 现在由服务器**独占续期权**：relay 存一份凭证，`token-keeper` 定时续期，设备只拉取、不本地续期。

## 架构

```
        ┌───────────── 腾讯云 VPS ─────────────┐
设备 A ─┤ relay-server (8787)   token-keeper   ├─► panservice.mail.wo.cn
设备 B ─┤   GET/POST /credentials   每 30 分钟  │      （exchange 换新）
        └──────────────────────────────────────┘
```

- `relay-server.mjs`：只做存取，明文 `{accessToken, refreshToken, savedAt, refreshedAt, via}`（0600）
- `token-keeper.mjs`：每 30 分钟检查，token 年龄 ≥ 80% 周期就 exchange；失败退避 5 分钟，再失败走 refreshToken 兜底
- 客户端：`dispatch` 撞 1001 → 先向 relay 拉最新 token → 重试；**配了 relay 就绝不本地续期**

## 部署（腾讯云 VPS，Node 18+）

```bash
# 1. 文件（relay-server.mjs / token-keeper.mjs / wocloud-core.mjs 放同目录）
scp relay/relay-server.mjs relay/token-keeper.mjs wocloud-core.mjs server:/opt/wocloud-relay/

# 2. relay（只监听内网，公网走 Nginx）
RELAY_KEY="<强口令>" RELAY_FILE=/opt/wocloud-relay/relay-creds.json \
RELAY_HOST=172.17.0.1 RELAY_PORT=8787 \
pm2 start /opt/wocloud-relay/relay-server.mjs --name wocloud-relay

# 3. 保活进程
RELAY_FILE=/opt/wocloud-relay/relay-creds.json TOKEN_REFRESH_MINUTES=30 \
pm2 start /opt/wocloud-relay/token-keeper.mjs --name wocloud-token-keeper

pm2 save
```

Nginx（TLS 反代）：

```nginx
location /wocloud-relay/ {
    proxy_pass http://172.17.0.1:8787/;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## 客户端

```bash
# 首次：已登录设备把当前凭证推上去（同时记住 url+key 到 ~/.wocloud/relay.json）
node wocloud.mjs token --push --relay https://<域名>/wocloud-relay --key <口令>

# 其他设备：一条命令完成登录（之后参数可省）
node wocloud.mjs token --pull
node wocloud.mjs doctor   # relay 托管: ✅ … / 续期链路: ✅ relay 可达
```

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/credentials` | 返回 `{accessToken, savedAt, refreshedAt, via}`（不返回 refreshToken） |
| POST | `/credentials` | 写入 `{accessToken, refreshToken?, savedAt?}`；旧加密 blob 返回 400 |
| GET | `/health` | `{ok, hasToken, savedAt, ageSeconds, via}`，免鉴权，供探活 |

鉴权头：`X-Relay-Key`（兼容旧的 `X-Hub-Key`）。

## 安全取舍（重要）

旧版是端到端加密、服务端只见密文；**保活必须能拿 token 去 exchange，所以现在服务端持有明文**。

| 层 | 措施 |
| --- | --- |
| 文件 | `0600`，仅 root；磁盘快照/备份要排除 |
| 传输 | Nginx TLS；key 只走 header |
| 鉴权 | `X-Relay-Key` 恒定时间比较，错 key 一律 403 |
| 暴露面 | 8787 只绑 docker 网桥（172.17.0.1），公网不可达 |
| 泄露后 | 网页端退出登录 / 重新扫码，然后 `token --push` 覆盖；旧 token 立即失效 |

## 运维

- 看保活：`pm2 logs wocloud-token-keeper --lines 20`；`curl https://<域名>/wocloud-relay/health`
- 手工强制续期：把 `relay-creds.json` 的 `savedAt` 改旧，重启 keeper 或等下一轮
- relay 挂了：设备仍能用手上未过期的 token；过期后无法续期（会明确报 1001，不会偷偷互踢）
- 迁移/重建：新机器部署后，任一设备 `token --push` 一次即可

## 已知边界

- 单点：relay + keeper 都在 VPS 上，VPS 故障 = 续期停摆（数据面下载/上传不受影响）
- 每次续期会让所有设备的旧 token 立即失效，设备下一次请求会自动拉新（一过性重试，用户无感）
- 口令忘了 = 用 `RELAY_KEY` 重启 relay 换新口令，再 `token --push`
