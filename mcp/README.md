# mcp/ — 联通云盘 MCP Server（已实现）

零依赖 MCP Server（stdio / Streamable HTTP 两种传输），让 Agent 直接用自然语言操作联通云盘：

```
你说  「把桌面这个月的设计稿传云盘」
Agent 自己: 扫描 → 建目录 → push → 汇报
```

## 快速开始

```bash
# 手动验证（应看到 25 个工具就绪的 stderr 日志）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node mcp/server.mjs
```

配置已写入 `~/.workbuddy-ai/mcp.json`（server 名 `wocloud`）。
**首次使用需在连接器管理页面对 `wocloud` 点「信任」**，之后当前会话即可调用。

**token 免登录**：Server 自动从联通云盘 macOS 客户端的 leveldb 读取已登录会话
（`~/Library/Application Support/wocloud/Local Storage/leveldb`）。
也可用环境变量 `WOCLOUD_TOKEN` 覆盖。

## 架构

```
mcp/
├── server.mjs             入口：只做一件事——选传输层（默认 stdio，--http 走 HTTP）
├── protocol.mjs           JSON-RPC 2.0 分发（initialize / ping / tools/list / tools/call）
├── tools.mjs              25 个工具的实现（与传输层完全无关）
├── transport/
│   ├── stdio.mjs          行分帧 + 串行队列 + stdin 关闭时等在途请求
│   └── http.mjs           Streamable HTTP + Bearer 鉴权 + SSE 进度
└── lib/
    └── wocloud-core.mjs   核心模块（协议/加密/上传/下载，从 CLI 抽离）
```

传输层和工具层是分开的：两套传输共用同一份 `handleMessage`，
所以 stdio 和 HTTP 的行为不会分叉。请求级状态（进度回调、已推分片、
取消信号）通过 `rt` 对象按请求传入，**没有任何模块级全局状态**——
同一个进程能同时服务多个客户端，进度不会串到别人的请求上。

- **CLI 不受影响**：`cli/wocloud-cli.mjs` 原样保留，两条路并存
- **零 npm 依赖**：不需要 `@modelcontextprotocol/sdk`，协议层约 100 行自实现
- **串行处理消息**：响应顺序与请求顺序一致
- **长任务进度通知**：上传/镜像下载时若客户端传 `_meta.progressToken`，
  Server 会推送 `notifications/progress`（分片级）

## 工具清单（25 个）

| 工具 | 说明 | confirm |
| --- | --- | --- |
| `wocloud_whoami` | 当前账号信息 | - |
| `wocloud_usage` | 容量使用（已用/总计/占比/知识库） | - |
| `wocloud_ls` | 列目录（dir 默认 "0"） | - |
| `wocloud_find` | 搜索文件（返回 fid） | - |
| `wocloud_tree` | 递归盘点目录树（depth 默认 3） | - |
| `wocloud_path` | 目录 id → 可读路径（面包屑） | - |
| `wocloud_by_type` | 按类型浏览（图/视/音/档），可全盘 | - |
| `wocloud_download` | 取下载直链或直接下载到本地 | - |
| `wocloud_upload` | 上传文件（秒传+分片+断点续传） | - |
| `wocloud_push` | 递归上传目录，云端自动建相同结构 | - |
| `wocloud_mirror` | 云盘目录增量镜像到本地（支持 dryRun） | - |
| `wocloud_mkdir` | 建目录 | - |
| `wocloud_copy` | 复制文件/目录（非破坏性，无需 confirm） | - |
| `wocloud_batch_rename` | 批量重命名（前缀/后缀/序号规则） | 强制 |
| `wocloud_favorite` | 收藏/取消收藏 | - |
| `wocloud_favorite_list` | 收藏列表 | - |
| `wocloud_versions` | 文件历史版本列表 | - |
| `wocloud_sync_units` | 同步盘单元列表（只读） | - |
| `wocloud_rename` | 重命名 | 强制 |
| `wocloud_mv` | 移动文件/目录 | 强制 |
| `wocloud_rm` | 删除（recursive 递归） | 强制 |
| `wocloud_trash` | 回收站列表（含 deleteNo） | - |
| `wocloud_restore` | 从回收站还原 | 强制 |
| `wocloud_purge` | 彻底删除（不可恢复） | 强制 |
| `wocloud_empty_trash` | 清空回收站（不可恢复） | 强制 |

## 安全设计（核心）

破坏性工具的 schema 强制 `required: ["confirm"]`——**代码级硬约束**，
模型不传 `confirm` 字段，客户端直接拒绝调用；传 `confirm:false` 只返回预演计划：

```jsonc
{
  "ok": true,
  "preview": true,
  "action": "删除",
  "message": "预演模式：未执行任何删除操作。确认无误后请带 confirm:true 重新调用本工具。",
  "plan": [{ "taskType": "DELETE", "sourceFileIds": ["..."], ... }]
}
```

等价于 CLI 的「默认预演 + `--yes`」机制，但由 schema 强制而非提示词约定。

## 远程部署（Streamable HTTP）

stdio 的痛点是「一份配置绑一台设备」：平板、电脑、服务器各配一遍，token 还得手工搬。
HTTP 模式下 MCP 跑在服务器上，多端共用一个端点，配置只写一次。

```bash
# ⚠️ HTTP 模式必须带鉴权。这个 server 有 rm / purge / empty_trash，
#    无鉴权的公网端点等于把云盘删除权开放出去。
MCP_TOKEN=$(openssl rand -hex 16) node mcp/server.mjs --http --host 0.0.0.0 --port 8788

# 本机调试可以关掉鉴权
node mcp/server.mjs --http --no-auth --port 8788
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/mcp` | MCP 端点，需 `Authorization: Bearer <token>` |
| GET | `/healthz` | 健康检查，不需要鉴权 |
| GET / DELETE | `/mcp` | `405`（2026-07-28 版已移除协议级会话与 GET 流） |

```bash
curl -s http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

客户端配置（Claude Code / 任意 Streamable HTTP 客户端）：

```json
{
  "mcpServers": {
    "wocloud": {
      "type": "http",
      "url": "https://<你的域名>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Nginx 反代要点：`location /mcp` 要加 `proxy_buffering off;`（否则进度通知会被缓冲住），
`proxy_read_timeout` 放宽到长任务需要的时长。

**协议版本**：支持 `2026-07-28`（现行，无会话）到 `2024-10-07`。
客户端带 `_meta.progressToken` 时响应切到 `text/event-stream`，
`notifications/progress` 就写在同一个流里；不带则普通 JSON 一次返回。

## 设计边界

**单用户设计：一个进程 = 一个联通云盘账号。**

token 解析是进程级的（`tokenOverride` / `WOCLOUD_TOKEN` 全局一份），这是**刻意的**：
个人自用场景下多租户是伪需求，硬做只会把代码做复杂。

要多人共用必须改三处：按请求解析 token、token 缓存按身份分桶、加审计日志。
在改之前**不要把这个端点开放给第二个人**。

破坏性工具的安全是两层，缺一不可：

- **schema 层**：`required: ["confirm"]` —— 约束「遵守协议的客户端」（大多数模型客户端会按 schema 拒绝调用）
- **handler 层**：`a.confirm !== true` 才执行 —— 真正的闸

但注意：**schema 只是给模型看的提示，不是安全边界。** 走 HTTP 之后任何人可以手写请求直接
`tools/call` 并自带 `confirm: true`，所以公网部署时 `MCP_TOKEN` 是必需品，不是可选项。

## 已知边界

- 上传/下载性能与 CLI 一致（MCP 不解决速度，只解决交互门槛）
- `find` 走 `SearchFileV3`，大结果集分页由客户端控制 `pageSize`
