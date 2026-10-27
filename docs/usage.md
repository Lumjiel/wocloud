# 联通云盘使用与维护手册

> 2026-10-15 定稿 · 10-25 跨设备版更新 · **10-26 增补**（CLI 38 命令 / 上传区域自动解析 /
> 账号 limits / 类型规则 types / 他人分享 share-info·share-ls·share-dl / 直链 V1→V2 兜底）。
> 基于 10-14/15 两天的实战（4700+ 文件备份、1000 照片归置、10 个服务端坑）。
> 自动化已明确 pass —— 节律靠「命令足够好用」，本文档就是让命令好用的。

---

## 〇、跨设备速记（2026-10-25 新增）

- CLI 真身在项目根：`node wocloud.mjs <命令>`（`cli/wocloud-cli.mjs` 为兼容 shim，行为一致）
- 登录：`node wocloud.mjs login`（终端二维码，手机 App 扫码）；token 自动续期，无需人工维护
- 体检：`node wocloud.mjs doctor`（凭证/鉴权/续期链路/容量一次看全）
- 新增常用：`cp` `batch-rename` `fav`/`fav-list` `versions` `by-type` `path` `share`/`share-list`/`unshare`
- 10-26 新增：`limits`（账号上限）`types`（文件类型规则）
  `share-info`/`share-ls`/`share-dl`（他人分享链接，`--code` 提取码）`download --api v1|v2`
- 上传/镜像默认带大小校验；异常先跑 `doctor`
- token 由**服务器托管**（`token-keeper` 每 30 分钟续期）：设备 `token --pull` 一次即可；遇 1001 自动拉最新，不再互踢
- 新设备接入：`node wocloud.mjs token --pull`（url+key 已记在 `~/.wocloud/relay.json`）

---

## 一、三通道规划（各司其职，不混用）

| 通道 | 放什么 | 谁负责 | 关键认知 |
| --- | --- | --- | --- |
| **我的同步盘** | 日常活跃文件（正在改的文档） | 官方客户端，双向实时 | **同步盘 ≠ 备份**：本地删云端也删 |
| **工作区**（项目/知识/收件箱） | 10-Projects + 40-Knowledge 的**异地快照** | `tools/wocloud-bulk.mjs` | 备份是单向快照，云端改动不回传 |
| **媒体区**（照片/大疆/视频/音乐） | 手机/无人机素材，只进不出 | 手机自动上传 + 偶尔手动归置 | 照片已按 `YYYY/YYYY-MM`、大疆按架次 `YYYY-MM-DD` 归位 |

与本地 PARA 的映射：`10-Projects ↔ 工作区/项目`、`40-Knowledge ↔ 工作区/知识`、`60-Archive ↔ 归档`、`90-Sandbox 不入云`。

---

## 二、日常操作（就这几条命令）

> 想先知道账号能装多少：`node wocloud.mjs limits`（单目录文件数上限、回收站保留天数、单次选择上限）。

### 别人的分享链接（解析 → 列出 → 下载）

```bash
node wocloud.mjs share-info https://pan.wo.cn/s/xxxxxxxxxxx --code abcd   # 谁分享的、什么时候过期
node wocloud.mjs share-ls   https://pan.wo.cn/s/xxxxxxxxxxx --code abcd   # 顶层文件
node wocloud.mjs share-dl   https://pan.wo.cn/s/xxxxxxxxxxx 1 --code abcd --out ./a.jpg --segments 8
```

- 提取码从分享页/对方消息里拿，缺失会报「请求参数错误」
- `share-dl` 只支持**单文件**（目录分享需先转存到自己云盘）；直链按你的登录态签发，120 分钟过期会自动换链

### 备份（增量，秒传让重跑很快）

```bash
cd ~/Desktop/Workspace/10-Projects/wocloud

# 知识库
caffeinate -is node tools/wocloud-bulk.mjs backup \
  ~/Desktop/Workspace/40-Knowledge 33101c73ed8443d39613dafb09a7e8dc --label 知识库

# 项目
caffeinate -is node tools/wocloud-bulk.mjs backup \
  ~/Desktop/Workspace/10-Projects <工作区/项目目录id> --label 项目
```

- **caffeinate -is 必须带**：后台长任务遇系统睡眠会全部 `fetch failed`（10-14 深夜踩过）
- 秒传机制：已上传过的文件重跑秒过，**全量重跑 ≈ 增量成本**
- 结束若有失败，自动生成 `<label>-failures.json`：

```bash
# 只重跑失败项
node tools/wocloud-bulk.mjs backup <本地目录> <云端id> --label 项目 --resume 项目-failures.json
```

### 校验（备份后跑一次，一分钟）

```bash
node tools/wocloud-bulk.mjs verify <本地目录> <云端id>
```

输出「真实缺失 / 多出错位」。0 字节文件的缺失会单独标注（可忽略）。

### 修错位（verify 报"多出"时）

```bash
node tools/wocloud-bulk.mjs clean <本地目录> <云端id>          # 预演
node tools/wocloud-bulk.mjs clean <本地目录> <云端id> --yes    # 执行
```

只删「云端根级有、本地顶层没有」的条目 —— 前提是正确位置已有副本（先 verify）。

---

## 三、节律建议（手动，非自动化）

| 时机 | 动作 |
| --- | --- |
| 每次大改动后 / 每周 | `backup` 知识库 + 项目 → `verify` |
| 照片积累几百张后 | 手机先传云盘，再用归置脚本按月归位 |
| 每月 1 日 | 顺手看一眼 `usage`（当前 55G/2T，短期内无压力）|
| 回收站 | 保留 15 天缓冲，确认无误删后再清（当前 39 项 ≈ 2.56 GB，10-29 前后可清）|

---

## 四、故障排查速查（22 个真实踩过的坑）

| # | 症状 | 真相 | 对策 |
|---|---|---|---|
| 1 | `CreateDirectory` 间歇"系统异常" | 服务端限流，与目录是否存在无关 | 节流 1.8s + 重试（工具已内置）|
| 2 | push 后文件散落根目录 | 建目录失败时 `?? targetId` 静默回退 | 已修 CLI；用 wocloud-bulk 则天然规避 |
| 3 | `mv` 传 ≥2 个文件报 500 | **服务端一次只能 MOVE 1 个** | 工具已内置单文件循环 |
| 4 | mv 重跑全部失败 | mv 成功后文件 `fileVersion` +1，旧数据失效 | 重抓数据再跑（重抓成本 = 一次查询）|
| 5 | 移走文件后原目录还显示旧的 | QueryAllFiles 读缓存/一致性延迟 | 等几分钟，用 `find` 或子目录查询交叉验证 |
| 6 | 上传 0 字节文件 400 | 云盘不收空文件 | 工具已自动跳过并记入清单 |
| 7 | 后台任务一夜之间全 `fetch failed` | Mac 睡眠断网，且中途无任何感知 | `caffeinate -is` 包裹（必须）|
| 8 | 任务中途无声卡死十几分钟 | CLI 单次调用无超时 | 工具已加 10 分钟硬超时 |
| 9 | `ls` 只返回 100 条 | pageSize 硬编码且静默截断 | `ls --limit 1000` 或用 `raw QueryAllFiles` |
| 10 | 批量删目录报 500 | 删除同样受频率限制 | 逐个删、间隔 1s+（clean 已内置）|
| 11 | 下载到一半报 `HTTP 519 / 518 / 403` | 直链签发后 **120 分钟到期且不随访问滑动**（rclone wopan 后端 2026-09-30 实测）；519=自然过期、518=URL 被篡改、403=撤销 | 已内置换链续传：`download`/`mirror` 自动重签直链并从断点继续，换链次数上限 5 |
| 12 | 探测/分段突然成片 `404` | CDN 反滥用：短时间大量 Range 请求会被打成 404，与文件是否存在无关（实测连打 10 次仅 1 次 206） | 已内置探测重试 3 次 + 分段 404 视为瞬时错误，指数退避带抖动 |
| 13 | 换账号/换地区后上传卡住或全失败 | 上传域名**按账号分区**（`GetZoneInfo` 返回 `hyupload` / `tjupload` / `gxupload`…），旧版把 `tjupload` 写死在代码里 | 2026-10-26 已改为首次上传前解析 `GetZoneInfo` 并缓存；解析失败或该域名 5xx/404/网络错误时自动回退 `tjupload` 重试一次 |
| 14 | 批量上传到某个目录，跑到一半被服务端拒 | 单目录文件数有**会员等级上限**（`QuerySysConfig.vip_level_file_num_limit`：等级 0/4/5→100，1/6/7→1000，2/8→5000，3/9/10→不限） | `upload`/`push` 启动前预检（超过 100 才查，只提示不阻断）；`wocloud limits` 可随时看当前等级对应上限；**2026-10-26 实测：101 个同目录上传成功，配置值不是硬限制** |
| 15 | 分享短链打开后要输提取码，脚本直接调 `ShareFileDetail` 报「请求参数错误」 | 短链 302 的 `Location` **不一定带 `shareCode`**（本机实测：有的带 `vVzN`，有的只带 `shareId`）；缺 code 时服务端只回 1000 参数错误，不提示要码 | `share-ls/share-dl` 加 `--code <提取码>`；`share-info` 会显示是否需要码 |
| 16 | 分享文件能列出来，但 `share-dl` 取直链报错 | 分享页下载**要求登录态**：直链走 `GetDownloadUrlV2`，fid 是分享里的 fid，但签发按你自己的账号 | 确认 `doctor` 正常（有 accessToken）再 `share-dl`；未登录只列文件 |
| 17 | `download`/`mirror` 取直链报「系统异常」 | V1（`GetDownloadUrl`）偶发抽风；两条通道返回域名可能相同，但 V2 往往还能出链 | 已内置兜底：V1 失败/空地址自动换 V2（打印「V1 失败（…）→ 已用 V2」）；想强制走 V2 加 `--api v2`。直链 120 分钟到期，下载器用到 25 分钟会主动换链 |
| 19 | 回收站「剩余保留天数」与配置表对不上；翻页拿到大量重复 | 服务端按条目下发 `keepDays`（本账号实测 **15 天**，`QuerySysConfig` 说 7 天）；`deleteTime` 相同的条目排序不稳定，同一批会在多页重复出现（实测 105 条翻出 2000 条） | 只信条目自己的 `keepDays`；`fetchRecycleAll()` 按 `deleteNo` 去重、连续两页无新增才停；`trash`/`purge`/`empty-trash` 清空前会统计「N 项将在 2 天内到期」，`--soon-days <n>` 可调阈值 |
| 20 | `rm <fid>` 提示成功，文件却还在 | 删除接口 `createTask` 吃的是**短 `id`**；传长 `fid` 时服务端照样回 `200`，但什么都不删 | `ls`/`find`/`by-type` 现在同时打印 `id=` 和 `fid=`；**删除用短 id，下载才用 fid** |
| 22 | 一台设备续期后，另一台突然 1001；`token --pull` 拉回来还是旧的 | `exchange` 续期会**立即作废旧 token**（实测 3/3）；旧 relay 只存密文、不续期，三端各存一份互相踢 | 已改为服务器唯一续期（`relay/token-keeper.mjs`，30 分钟 exchange）＋设备 1001 自动拉 relay；`doctor` 会显示「relay 托管 / 续期链路」|
| 21 | 上传 64MB 时 Node 进程 RSS 涨到 400MB+ | 旧实现每分片 `Buffer.alloc(16MiB)` × 6 并发，叠加 FormData/fetch 拷贝（实测峰值增量 356MB） | 已改 `fs.openAsBlob()` + `slice()`（Blob 由文件句柄支撑，不整块读内存）；实测 64MB 上传峰值增量 **356MB → 76MB**，老 Node（<19.8）自动回退旧路径 |
| 18 | 上传后文件名变短了 / 上传报 500 或「名称中含有非法字符」 | 云盘名字规则（rclone 实测）：**> 100 字符会被静默截断**（变成另一个文件）；非 BMP 字符（😀）回裸 500；BMP emoji（© ® ™ ❤）回 1009 | 上传前已预检：超长直接拒绝；含 emoji 打印警告（不拦，失败请改名）。见 `docs/techniques.md` |

**通用心法**：凡是"返回 200/成功但结果不对"的操作，一律视为失败 —— 这套接口的静默失败远多于报错失败。

---

## 五、安全红线（不变）

- 凭证永不入云：`.env*` `*.pem` `*.key` `*.p12` `id_rsa*` `*credential*` 硬排除（工具内置）
- 同步盘 ≠ 备份；异地备份看 `工作区/`
- 私密空间（spaceType=4）未接入，同步功能显式排除
- 破坏性操作（rm/mv/clean）全部默认预演，`--yes` 才执行

---

## 六、相关文件

| 文件 | 内容 |
| --- | --- |
| `tools/wocloud-bulk.mjs` | 批量备份/校验/清理工具（本手册的主角）|
| `tools/pc-upload-regression.mjs` | PC 端真实上传回归（小/大文件 + 覆盖语义 + 中断安全 + 上限探测；平板不要跑）|
| `relay/relay-server.mjs` + `relay/token-keeper.mjs` | 部署在 VPS：凭证存取 + 唯一续期者（详见 `relay/README.md`）|
| `wocloud-core.mjs` + `wocloud.mjs` | 核心协议 + CLI（38 命令，`raw` 可直调任意接口）|
| `mcp/` | 25 工具的 MCP Server（Agent 自然语言操作入口，冻结维护）|
| `docs/roadmap.md` | 对照 wopan-sdk-go 的未接入端点、实现优先级与分享协议实测 |
| `docs/protocol.md` | 协议真源（含 7.8 分享链接、7.9 区域/配置/类型接口）|
