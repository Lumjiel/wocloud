# 联通云盘 CLI (wocloud)

> 🔁 **2026-10-25 起本文件改为兼容 shim**：CLI 真身已上移到 [../wocloud.mjs](../wocloud.mjs)，
> 协议与 token 管理在 [../wocloud-core.mjs](../wocloud-core.mjs)。
> `node wocloud-cli.mjs <命令>` 仍然可用（tools/ 与 bench-upload.mjs 依赖此路径），
> 命令清单与用法不变；新增 `token` 命令（`--save` / `--refresh` / `--export`），
> token 解析链与跨设备迁移说明见 [../README.md](../README.md)。

基于对「联通云盘」macOS 客户端 v2.8.13 的静态逆向，实现的第三方命令行工具。
零依赖，仅用 Node 内置模块（需 Node 18+，使用内置 `fetch`）。

> ⚠️ **合规提示**：本项目为互操作性技术研究。使用前请自行确认符合联通云盘用户协议与当地法律法规。请仅用于个人账号的数据访问，勿用于批量抓取或任何破坏服务的行为。

---

## 快速开始

```bash
# 1. 直接运行（自动复用本机客户端已登录的 token）
node wocloud-cli.mjs whoami

# 2. 列出根目录
node wocloud-cli.mjs ls

# 3. 搜索文件
node wocloud-cli.mjs find 报告

# 4. 下载（复制 find/ls 结果里的 fid）
node wocloud-cli.mjs download "<fid>" --out ./report.docx
```

可加个软链方便调用：

```bash
chmod +x wocloud-cli.mjs
ln -s "$PWD/wocloud-cli.mjs" /usr/local/bin/wocloud
wocloud ls
```

---

## 命令

| 命令 | 说明 |
| --- | --- |
| `whoami` | 查询当前登录用户信息 |
| `usage` | 查询容量使用情况（带进度条） |
| `ls [--dir <id>]` | 列出目录内容（默认根目录 `0`） |
| `tree [--dir <id>] [--depth <n>] [--json]` | 递归盘点目录树与占用统计 |
| `find <关键字>` | 搜索文件，返回含 `fid` 的结果 |
| `download <fid> [--out <路径>]` | 获取下载直链；带 `--out` 则直接下载落盘 |
| `upload <本地文件> [--dir <id>] [--concurrency <n>]` | 上传文件（秒传检查 + 16 MB 分片并发 + 重试） |
| `mirror <云盘目录id> <本地路径> [--dry-run]` | 把云盘目录镜像到本地（增量 + 断点续传） |
| `mkdir <名称> [--dir <id>]` | 新建目录 |
| `rename <id> <新名字> [--dir] [--version <n>] [--yes]` | 重命名文件/目录 |
| `rm <id...> [--dir] [--version <n>] [--yes]` | 删除文件/目录（**默认只预演**） |
| `mv <id...> --to <目录id> [--dir] [--version <n>] [--yes]` | 移动文件/目录（**默认只预演**） |
| `trash [--limit <n>] [--json]` | 查看回收站 |
| `restore <deleteNo...> [--yes]` | 从回收站还原 |
| `purge <deleteNo...> [--yes]` | 彻底删除（不可恢复） |
| `empty-trash [--yes]` | 清空回收站（不可恢复） |
| `post <路径> [jsonBody]` | 直接 POST 到 panservice（调试用） |
| `raw <key> [jsonBody]` | 直接调用任意 dispatcher 接口（调试用） |

### ⚠️ 破坏性操作

`rm` / `mv` / `rename` / `restore` / `purge` / `empty-trash` **默认只预演**，会打印将要发送的参数而不执行。确认无误后加 `--yes` 才真正生效。

```bash
# 先看会删什么
node wocloud-cli.mjs rm <id> --dir

# 确认后执行
node wocloud-cli.mjs rm <id> --dir --yes
```

**删除/移动/重命名文件时必须带 `--version <文件版本号>`**（目录不需要）。版本号见 `ls` / `find` 输出里的 `fileVersion` 字段，普通文件通常是 `1`。**不带这个参数接口会返回成功但文件纹丝不动**，是个很容易踩的坑。

### 上传

```bash
# 单文件
node wocloud-cli.mjs upload ./report.docx --dir <目录id>

# 多文件并发（自动小文件优先）
node wocloud-cli.mjs upload a.jpg b.mp3 c.iso --dir <目录id>

# 递归上传整个目录，自动在云端建出相同结构
node wocloud-cli.mjs push ./photos/2026 --to <目录id>

# 调并发
node wocloud-cli.mjs upload ./big.iso --dir <目录id> --concurrency 10
node wocloud-cli.mjs push ./dir --to <目录id> --files 8
```

流程：SHA256 → 秒传检查（命中则跳过）→ 16 MB 分片并发上传 → 输出 `fid`。

**并发模型**：
- `--files <n>`　同时上传的文件数（默认 5）
- `--concurrency <n>`　分片并发（默认 6）
- **全局在飞上限 8**：多文件共享一个信号量，防止 5 文件 × 6 分片把带宽打满
- 小文件优先排队，避免被大文件堵住

**实测**（4 个 8MB 文件）：

| 模式 | 耗时 | 吞吐 |
| --- | --- | --- |
| 串行 (`--files 1`) | 6.66 s | 4.9 MB/s |
| 并发 (`--files 4`) | 2.83 s | 11.6 MB/s |

**稳定性**：
- **断点续传** —— 中断后重跑同一条命令即自动续传（状态存在 `~/.wocloud-cli/uploads/`）
- **超时控制** —— 分片 180s、秒传 30s，不会永久挂起
- **智能重试** —— 网络类错误指数退避重试；容量不足/参数错误立即失败不空转
- **失败即停** —— 出现致命错误后不再派发新分片

### 递归删除

云盘目录**非空时不能直接删**（服务端返回 `5056`），需要 `--recursive`：

```bash
# 先看会删什么（预演模式）
node wocloud-cli.mjs rm <目录id> --dir --recursive

# 执行：先批量删内部文件，再逐个删空目录（深层优先）
node wocloud-cli.mjs rm <目录id> --dir --recursive --yes
```

详细的实测数据、瓶颈分析和改进记录见
[`docs/performance.md`](../docs/performance.md)。

自测基准：

```bash
node bench-upload.mjs <目录id> 96 2,3,6,12
```

### 回收站

```bash
node wocloud-cli.mjs trash                    # 列出回收站，拿到 deleteNo
node wocloud-cli.mjs restore <deleteNo> --yes # 还原（回到原父目录）
node wocloud-cli.mjs purge <deleteNo> --yes   # 彻底删除
node wocloud-cli.mjs empty-trash --yes        # 清空
```

### 全局参数

| 参数 | 说明 |
| --- | --- |
| `--token <token>` | 指定 accessToken（默认自动从客户端本地存储读取） |
| `--client-id <id>` | clientId，默认 `1001000210` |
| `--secret <key>` | secretKey，默认 mac 平台内置值 |
| `--space <n>` | 空间类型，`0`=个人（默认） |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `WOCLOUD_TOKEN` | 等价于 `--token` |

---

## token 从哪来

CLI 按以下优先级获取 accessToken：

1. `--token` 参数
2. `WOCLOUD_TOKEN` 环境变量
3. **自动读取本机客户端已登录会话** —— 解析
   `~/Library/Application Support/wocloud/Local Storage/leveldb/`
   中的 `WoCloud-Web-Token` 键

因此只要本机「联通云盘」客户端处于登录状态，无需任何配置即可直接使用。

> 凭证也会落盘到 `~/.wocloud/credentials.json`（`token --save`）。配了 relay 的设备还会在
> `~/.wocloud/relay.json` 记住服务器地址与口令，遇 1001 自动向服务器拉最新 token（续期由服务器负责）。
> 详见根目录 README 的「跨设备登录」与 `relay/README.md`。

---

## 协议速览

逆向自 `app.asar` → `js/app.js`。完整说明见 [`docs/protocol.md`](../docs/protocol.md)。

```
两个 dispatcher：
  api-user  POST /api-user/dispatcher   channel="api-user"  参数用 secretKey 加密
  wohome    POST /wohome/dispatcher     channel="wohome"    参数用 accessToken 加密

请求 header:
  { key, resTime, reqSeq, channel, sign, version:"" }
  sign = md5(key + resTime + reqSeq + channel + "")

加密:
  AES-128-CBC / PKCS7
  IV  = "wNSOYIB1k1DjY5lA"   (固定)
  key = secretKey 或 accessToken（超 16 字节则截断）

响应:
  { STATUS, MSG, LOGID, RSP:{ RSP_CODE, RSP_DESC, DATA } }
  DATA 为字符串时需 AES 解密
```

---

## 与电脑整合

三种方式，按场景选：

| 场景 | 方案 |
| --- | --- |
| 需要**双向实时同步**（如文档目录） | 用客户端自带的「同步盘」（官方 FileProvider，稳定有冲突处理） |
| 需要**云盘 → 本地备份**（如航拍素材） | 用本工具 `mirror`，增量 + 断点续传 |
| 需要**定期自动备份** | `mirror` + cron |

```bash
# 云盘 → 本地增量镜像
node wocloud-cli.mjs mirror <目录id> ~/Backup/wocloud

# 预演（只看会下载什么，不写盘）
node wocloud-cli.mjs mirror <目录id> ~/Backup/wocloud --dry-run
```

`mirror` 会递归建目录、跳过本地已存在且大小一致的文件，中断后重跑只补缺失部分。

空间整理与备份策略属于个人用法范畴，不在本文展开；命令层面的建议见
[`docs/usage.md`](../docs/usage.md) 的维护节律一节。

---

## 已知限制

- **上传为单文件串行**：单个文件内部是 6 分片并发，但一次只传一个文件（官方客户端支持 5 文件并发）。批量传大量小文件时不如官方客户端。
- **上传无事后校验**：传完不自动比对服务端文件大小，建议自行 `download` 回来验 SHA256。
- **秒传不稳定**：`quickTransfer` 的 `hasFile` 命中与否由服务端去重策略决定，未命中时照常上传。
- **回收站已支持**，但只能删除到回收站/还原/彻底删除，无独立的回收站容量统计。
- **协议随版本变化**：本实现基于 v2.8.13，客户端升级后密钥/签名方式可能改变。
- **仅适配 macOS 客户端**：`secretKey` 与 `pc-os` 按 mac 平台取值；Windows/Linux 需替换 `SECRETS.win` / `SECRETS.linux` 与 `pc-os`。

---

## 目录结构

```
wocloud-cli/
├── wocloud-cli.mjs            # CLI 主程序（零依赖）
├── README.md
└── docs/
    └── protocol.md         # 完整协议逆向报告
```

分析过程中的脚本与中间产物（asar 解析器、提取出的 `app.js` / `background.js` 等）
不随仓库提供，需要时请自行从自己安装的客户端中提取。
