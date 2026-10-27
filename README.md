# wocloud

**联通云盘第三方客户端 —— 命令行工具 + MCP Server，零 npm 依赖。**

![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Termux-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

把云盘变成可用脚本和 Agent 操作的东西：38 个 CLI 命令 + 25 个 MCP 工具，同一份代码跑在 macOS / Windows / 安卓 Termux 上。

*A zero-dependency CLI + MCP (Model Context Protocol) server for China Unicom Cloud Drive (联通云盘, `wocloud` / `wopan`) — file management, upload/download, sharing, trash and batch backup, scriptable on macOS, Windows, Linux and Termux, and directly operable by AI agents.*

> 本项目通过互操作性分析实现，**不是**官方客户端，与联通公司无任何隶属关系。使用前请阅读下面的[免责声明](#免责声明)。

---

## 免责声明

**请在动手之前读完这一节。** 本项目涉及对第三方客户端协议的分析，风险由使用者自行承担。

1. **非官方项目。** 本项目未获得联通公司或其关联方的授权、认可或支持。「联通」「联通云盘」等名称与商标归其各自权利人所有，本项目仅作客观指代，不构成任何形式的官方标识。
2. **仅限个人自用。** 设计目的只有一个：访问**自己账号**里的数据。请勿用于批量抓取他人数据、绕过付费/配额限制、绕过风控、二次分发或任何商业用途。
3. **合规责任在你自己。** 使用本项目可能违反服务提供方的用户协议，或与你所在地区的法律法规冲突。是否使用、如何使用，由你自行判断并承担全部后果。
4. **账号风险。** 高频或异常调用可能触发服务端风控，导致限流、限制功能甚至封禁账号。请保持与正常客户端相称的使用强度。
5. **服务随时可能失效。** 接口、签名、加密方式均由第三方控制，对方一次更新就可能让本项目完全不可用。不承诺跟进，不承诺可用性。
6. **不含任何凭证。** 仓库中不提供账号、token、密钥。你需要用自己的账号登录。请勿把自己生成的凭证提交到版本库（见 `.gitignore`）。
7. **不含逆向分析材料。** 本仓库不提供分析脚本、抓包数据或客户端解包产物（这类材料可能涉及第三方商业代码）。MIT 许可证仅覆盖本仓库内的源代码。
8. **按「现状」提供。** 软件存在缺陷是常态。因使用本软件造成的数据丢失、账号异常、时间损失或其他任何直接/间接损害，作者不承担责任。**重要数据请保留第二份备份，不要把云盘当唯一副本。**

如果你不接受以上任何一条，请立即停止使用。

---

## 这是什么

| 层面 | 内容 |
| --- | --- |
| **CLI** | 38 个命令，覆盖官方客户端的文件管理主体功能（上传/下载/整理/分享/回收站） |
| **核心库** | `wocloud-core.mjs`，单文件实现协议签名、AES 加解密、分片上传、断点续传、token 管理 |
| **MCP Server** | 25 个工具，支持 stdio（本地）与 Streamable HTTP（常驻服务）两种传输 |
| **批量工具** | `tools/wocloud-bulk.mjs`，带失败清单与 resume 的 backup / verify / clean |

技术底色：零 npm 依赖，只用 Node 标准库。Node 18+ 即可运行。

**为什么值得单独做一份：** 官方客户端只在桌面端提供图形界面，多设备之间的登录状态还会互相踢下线。本项目把「续期权」收敛到一台服务器上，其余设备只拉取，从而让手机、电脑、服务器同时在线。

---

## 特性

- **零依赖**：`git clone` 完直接 `node`，没有 `npm install` 这一步
- **三端一致**：macOS、Windows、安卓 Termux 跑同一份代码
- **断点续传**：上传按分片记录，中断重跑自动跳过已完成部分，SHA256 可校验
- **高速下载**：直链分段并行（32 段 ≈ 单流 17 倍），过期自动换链
- **多设备共存**：自建 relay + `token-keeper`，服务器独占续期，不再互踢
- **Agent 友好**：非 TTY 下自动静默进度条；MCP 让模型直接用一句话操作云盘
- **破坏性操作有闸**：`rm` / `purge` / `empty_trash` 默认只返回预演计划，需显式确认才执行

---

## 环境要求

- Node.js **18 或更高**（`node -v` 检查）
- 一个联通云盘账号
- 能上网的环境

无第三方依赖，无需数据库，无需编译。

---

## 安装

```bash
git clone https://github.com/Lumjiel/wocloud.git
cd wocloud
node wocloud.mjs doctor      # 自检：环境、凭证、连通性
```

想当全局命令用：

```bash
npm link          # 之后可直接 wocloud <命令>
```

安卓 Termux：

```bash
pkg install nodejs git
```

---

## 快速开始

```bash
# 1. 登录（终端出二维码，手机 App 扫一扫）
node wocloud.mjs login

# 2. 看看账号
node wocloud.mjs whoami
node wocloud.mjs usage
node wocloud.mjs ls
node wocloud.mjs tree --depth 12      # 全盘盘点

# 3. 传点东西
node wocloud.mjs upload ./file.iso --dir <目录id>
node wocloud.mjs push ./photos/2026 --to <目录id>      # 递归整个目录
node wocloud.mjs mirror <目录id> ~/Backup/wocloud      # 云端 → 本地镜像

# 4. 看别人的分享
node wocloud.mjs share-ls https://pan.wo.cn/s/xxxx --code abcd
node wocloud.mjs share-dl https://pan.wo.cn/s/xxxx 1 --code abcd --out ./a.jpg
```

单命令用法：`node wocloud.mjs help <命令>`。

> 在管道、重定向等非 TTY 环境里，进度条会自动静默，只输出完成行，可放心放进自动化脚本。

---

## 登录与多设备

**token 解析链（三端一致）：**

```
--token  →  WOCLOUD_TOKEN  →  ~/.wocloud/credentials.json  →  本机客户端 leveldb
```

token 失效（业务码 `1001`）会自动刷新并落盘；刷新失败再回退尝试客户端 leveldb。

**多设备共存的两种方式：**

| 方式 | 做法 | 特点 |
| --- | --- | --- |
| **自建 relay（推荐）** | 已登录设备 `token --push --relay <url> --key <口令>`，其他设备 `token --pull` | 服务器独占续期权，设备只拉取，**不会再互踢** |
| 扫码登录 | `node wocloud.mjs login`（`--image` 输出图片文件） | 简单，但每台设备各持一份 token |
| 迁移凭证 | 已登录机器 `token --save`，复制 `~/.wocloud/credentials.json` 到目标设备同路径 | 最快，但多设备仍会互相踢 |

relay 的取舍与部署见 [relay/README.md](relay/README.md)：保活必须调用 exchange（exchange 会作废旧 token），因此 relay 采用**明文存储 + `0600` + key 鉴权 + 仅内网监听**，而不是加密存储。

---

## 命令一览

共 **38 个命令**。批量备份与治理用 `tools/wocloud-bulk.mjs`，日常操作见 [`docs/usage.md`](docs/usage.md)。

| 分类 | 命令 |
| --- | --- |
| 身份 | `login`（扫码）`token`（`--save` / `--refresh` / `--export` / `--push` / `--pull`）`doctor` `whoami` |
| 查询 | `usage` `limits` `types` `ls` `tree` `find` `by-type` `path` `versions` `du` |
| 下载 | `download` `mirror`（32 段并行 + 多文件并发 + 字节级进度与 ETA；直链 V1 失败自动退 V2） |
| 上传 | `upload`（并发 + 断点续传）`push`（递归目录） |
| 管理 | `mkdir` `rename` `batch-rename` `cp` `rm` `mv` `fav` `fav-list` |
| 分享 | `share` `share-list` `unshare`；他人链接：`share-info` `share-ls` `share-dl` |
| 回收站 | `trash` `restore` `purge` `empty-trash` |
| 调试 | `post` `raw` |

---

## MCP Server

`mcp/` 下是一个完整的 Model Context Protocol 服务端：**25 个工具**，零依赖，支持两种传输。

```bash
# 本地：由客户端作为子进程拉起（stdio）
node mcp/server.mjs

# 远程：常驻 HTTP 服务（必须配置鉴权）
MCP_TOKEN=<强随机串> node mcp/server.mjs --http --port 8788
```

设计要点：

- **同一套协议逻辑，两种传输**：`protocol.mjs` 不碰 I/O，`transport/` 只负责分帧与连接
- **破坏性操作默认预演**：`rm` / `purge` / `empty_trash` 不带 `confirm: true` 时只返回执行计划
- **HTTP 模式无鉴权即拒绝启动**：这个 server 有删除权，公网裸奔等于开放云盘删除
- **进度按请求隔离**：`progressToken` 存在请求级闭包里，多客户端并发不会串条

协议版本对齐 `2026-07-28`（该版本移除了协议级会话、GET SSE 流与 `Last-Event-ID`）。

完整工具清单、部署方式与设计边界见 **[mcp/README.md](mcp/README.md)**。

---

## 实测数据

| 项目 | 结果 |
| --- | --- |
| 上传并发甜点 | **6 分片并发 ≈ 19.7 MB/s**，再高撞带宽天花板 |
| 下载单连接限速 | tjdownload 单连接 **~0.15 MB/s**（不同文件实测一致） |
| 下载分段并行 | 直链支持 Range（206）；**32 段 ≈ 2.5 MB/s（单流 17×）**，64 段仅 +5% → 默认 32 |
| 多文件并发 | 4 × 8MB：串行 6.66s → 并发 2.83s（**2.35 倍**） |
| 断点续传 | 中断后重跑自动跳过已完成分片，最终 SHA256 一致 |
| 上传完整性 | 20MB / 50MB / 160MB 上传后回下载，SHA256 全部一致 |

---

## 协议要点

详见 [`docs/protocol.md`](docs/protocol.md)。

- **双 dispatcher**：`/api-user/dispatcher`（secretKey 加密）与 `/wohome/dispatcher`（accessToken 加密）
- **签名**：`md5(key + resTime + reqSeq + channel + "")`，本身不含密钥
- **加密**：AES-128-CBC / PKCS7，固定 IV `wNSOYIB1k1DjY5lA`
- **上传域名按账号分区**（`GetZoneInfo`）；直链 120 分钟过期，需换链续传
- **分享/匿名接口**：`secretType: "clientSecret"`，body 必须带**顶层 `clientId`**，否则只返回 `1000 参数错误`

**两个最难查的坑：**

1. `clientType` 必须是数字 `1`。传字符串（如 `"MAC"`）时网关返回 `HTTP 400` 且**响应体为空**，只留一个 `X-Request-Id`。
2. 删除文件必须带 `fileVersion`。缺失时接口返回 `success: true`，**但文件根本没删，且没有任何错误提示**。

---

## 目录结构

```
wocloud/
├── wocloud-core.mjs      核心真源：协议 / 加密 / 上传下载 / token（零依赖）
├── wocloud.mjs           CLI 主程序（瘦壳，只做参数解析与输出）
├── mcp/                  MCP Server（25 工具）
│   ├── server.mjs            入口：选择传输方式
│   ├── protocol.mjs          JSON-RPC 分发（无 I/O）
│   ├── tools.mjs             25 个工具实现
│   └── transport/            stdio.mjs / http.mjs
├── relay/                凭证中转 + token 保活（服务器唯一续期）
├── cli/                  兼容 shim + 上传性能基准脚本
├── tools/                批量备份 / 治理工具（含失败清单与 resume）
├── docs/                 协议报告、性能实测、使用手册、路线图、手法参考
└── LICENSE / package.json
```

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`cli/README.md`](cli/README.md) | 命令用法、参数、已知限制 |
| [`mcp/README.md`](mcp/README.md) | MCP 工具清单、部署、设计边界 |
| [`relay/README.md`](relay/README.md) | 凭证中转与服务器续期的取舍 |
| [`docs/protocol.md`](docs/protocol.md) | 协议完整说明（签名 / 加密 / 接口 / 大坑） |
| [`docs/performance.md`](docs/performance.md) | 实测数据、断点续传、并发调优 |
| [`docs/usage.md`](docs/usage.md) | 日常用法、维护节律、踩坑速查 |
| [`docs/roadmap.md`](docs/roadmap.md) | 未接入端点、实现优先级、分享协议实测 |
| [`docs/techniques.md`](docs/techniques.md) | 上传下载可借鉴手法与落地优先级 |
| [`tools/README.md`](tools/README.md) | 批量备份工具的设计、实测与已知限制 |

---

## 已知限制

- 上传域名与可用的接口集**按账号分区**，不同账号行为可能不一致
- 单连接下载被服务端限速，只能靠分段并行绕开，不支持真正的多线程单文件加速
- relay 的凭证是明文存储（`0600` + key 鉴权 + 内网监听），不要在公网暴露
- 服务端接口随时可能变更，本项目不做及时跟进承诺

---

## 贡献

欢迎 Issue 与 PR。提交前请确认：

1. 不包含任何真实账号、token、文件 ID、手机号等个人信息
2. 不提交逆向分析脚本、抓包数据或第三方客户端代码
3. 改动经过实际账号验证，并在 PR 里说明测试环境（系统 / Node 版本 / 云盘客户端版本）

---

## 许可证

[MIT](LICENSE) © 2026 Lumjiel

许可证仅覆盖本仓库中作者编写的源代码，不涉及第三方软件、商标及逆向分析产物。详见 [LICENSE](LICENSE) 末尾说明。

---

## 致谢

- 协议字段与接口行为参考了社区对联通云盘客户端的公开分析，以及 `wopan-sdk-go` 等第三方实现的对照思路
- 上传下载的调优手法参考了 rclone 的设计

本项目与上述项目及联通公司均无隶属关系。
