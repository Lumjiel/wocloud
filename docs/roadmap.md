# 端点缺口对照：wopan-sdk-go → wocloud

> 2026-10-26 · 方法：拿 `OpenListTeam/wopan-sdk-go`（Apache-2.0）的 4 份接口文档与源码，
> 对照本仓库 `wocloud.mjs` / `wocloud-core.mjs` 的实际调用，找出"别人有、我们没有"的端点。
> 结论先行：**文件管理这条线我们更全；缺口集中在账号与空间维度。**

---

## 一、比对口径

| 侧 | 口径 | 数量 |
| --- | --- | --- |
| 参考 | `wopan-sdk-go/docs/{personal-fs,family-fs,wohome,api-user}.md` 里的 `header.key` | 20 个 key |
| 参考 | `wopan-sdk-go/*.go` 里的接口常量 | 23 个 key |
| 本仓库 | `dispatch("<Key>")` 直调 | 16 个 key |
| 本仓库 | 原始路径调用 | 4 条 |

本仓库直调：`QueryAllFiles` `CreateDirectory` `RenameFileOrDirectory` `GetDirectoryPath`
`GetDownloadUrl` `QueryTypeFiles` `SearchFileV3` `QueryRecycleData` `ReductionRecycleData`
`DeleteRecycleData` `EmptyRecycleData` `ShareFile` `AllShareFileList` `CancelOrDelShareFile`
`AppQueryUser` `AppRefreshToken`

原始路径：`/openapi/client/upload2C`、`/wohome/pass/file/batch/createTask`（复制/移动/删除）、
`/wohome/open/file/batchRename`、`/wocloud/favorite/*`。

> SDK 没有覆盖我们已有的：分享创建/列表/取消、回收站查询/恢复/单删/清空、批量重命名、
> 收藏、按类型浏览、路径面包屑、断点续传上传。**这块不用参考它。**

---

## 二、缺口清单（按优先级）

### P1 — ✅ 2026-10-26 已实现

| key | 能拿到什么 | 实测结果（2026-10-26，本机） |
| --- | --- | --- |
| `GetZoneInfo` | 账号所属**上传区域**的 base URL | 本账号返回 `https://hyupload.pan.wo.cn`，而 `wocloud-core.mjs` 里 `UPLOAD_API` **硬编码**为 `tjupload.pan.wo.cn`。两个域名当前都通（400/0.096s 延迟一致），但区域映射变了就会写出问题 |
| `QuerySysConfig` | 账号权益与限制：`vip_level_file_num_limit`（各 VIP 等级文件数上限）、`vip_level_recycle_bin`（回收站保留天数）、`file_max_select` | 实测返回真实配置。已落地 `wocloud limits` 命令 + `upload`/`push` 启动前预检（只提示不阻断） |

### P2 — 体验提升，非必需

| key | 能拿到什么 | 实测结果 |
| --- | --- | --- |
| `GetDownloadUrlV2` | 新版直链，入参 `{type:"1", fidList:[...]}`，出参 `list[]{fid, downloadUrl}` | 可用。本账号返回域名与 V1 相同（`hydownload`）→ 无速度差异，**已作为 V1 的兜底**接入下载链路 |
| `ClassifyRule` | 扩展名 → 类型映射（84 条有效规则，`type` 1~5 直接对上官方分类） | ✅ 2026-10-26 已接入：上传前拉取并缓存，`getFileType` 优先用服务端表、静态表兜底；`wocloud types` 可对比差异（服务端比静态表多覆盖 40 种扩展名） |

### P3 — 功能扩展，要动数据模型

| key | 能拿到什么 | 现状 |
| --- | --- | --- |
| `FamilyUserCurrentEncode` | 默认家庭空间 `defaultHomeId` / 成员角色 / 家庭名 | 未接入。本仓库只有 `familyId` 字段透传，没有命令 |
| `QueryAllFilesFamily` 等 `*Family` 变体 | 家庭空间的文件列表 / 重命名 / 移动 | 未接入 |
| `PrivateSpaceLogin` | 私人空间（`spaceType=4`）解锁 | `docs/usage.md` 已标注"私密空间未接入" |
| `GetSearchDirectory` | 按目录 id 查目录信息（返回 `directoryInfo[]`） | 未接入。与 `SearchFileV3` 互补，做路径补全时有用 |

### P4 — 登录方式，只有频繁换设备才值得

| key | 说明 |
| --- | --- |
| `PcWebLogin` | 手机号 + 密码登录，需网页端 `clientSecret`（见 `protocol.md` 第 6 节） |
| `PcLoginVerifyCode` | 手机号 + 短信验证码登录，参数同上 |
| `AppLogout` | 登出（使当前 token 失效） |

扫码已经能覆盖日常，这三种是"免扫码"的替代路径；缺点是密码/短信流程要处理风控与二次验证。

---

## 三、已等价覆盖（不算缺口）

| SDK key | 本仓库等价实现 |
| --- | --- |
| `CopyFile` / `MoveFile` / `DeleteFile` | `POST /wohome/pass/file/batch/createTask`（`taskType: COPY/MOVE/DELETE`） |
| `QueryCloudUsageInfo` | `POST /api/bff/member/info/card/storage`（`usage` 命令） |
| `RenameFileOrDirectory` / `CreateDirectory` / `EmptyRecycleData` | 同名直调 |
| `AppRefreshToken` | 已有，`doctor` 里显示为 `via exchange` |

---

## 四、实现进度与顺序

| 顺序 | 内容 | 状态 |
| --- | --- | --- |
| 1 | `GetZoneInfo` 动态上传域名（首次解析 + 缓存 + 5xx/404/网络错误回退 tjupload） | ✅ 2026-10-26 已实现（`resolveUploadServer` / `getUploadServer`） |
| 2 | `QuerySysConfig`：`limits` 命令 + `upload`/`push` 预检 | ✅ 2026-10-26 已实现（预检只提示不阻断，`memberLevel → 等级` 为推断映射） |
| 3 | `ClassifyRule` 替换硬编码类型表 | ✅ 2026-10-26 已实现（`ensureClassifyRules` / `types` 命令） |
| 4 | `GetDownloadUrlV2` 作为 V1 兜底 | ✅ 2026-10-26 已实现：`getDownloadUrl()` V1 优先、失败/空地址自动换 V2，`download`/`mirror` 全接入；`--api v2` 可强制首选 V2（两者域名通常相同，仅作容错） |
| 5 | 家庭空间 / 私人空间（`spaceType` + `familyId` 贯穿命令层） | ⏳ 待做，需单独设计 |
| 6 | 密码 / 短信登录 | ⏸ 暂缓，扫码够用 |

### 附：他人分享链接（不在 SDK 覆盖范围内，已实测打通）

| 环节 | 接口 | 加密 | 说明 |
| --- | --- | --- | --- |
| 短链 → shareId | `GET https://pan.wo.cn/s/<短码>`（302） | — | `Location` 里带 `shareId`，**不一定带 `shareCode`** |
| 分享元信息 | `QueryShareInfo` | `clientSecret` | 分享者昵称、VIP、有效期、是否失效 |
| 分享文件列表 | `ShareFileDetail` | `clientSecret` | 顶层条目，含 `fid` / `fileName` / `fileSize`；目录分享只给目录项 |
| 下载直链 | `GetDownloadUrlV2` | 自己的 accessToken | 分享 fid 直接用；未登录不行（网页端也是强制登录） |

> `QueryShareFiles` 参数未解（多种组合都回 1000）——目录型分享的内部浏览暂缺，需真机抓包再补。
> `clientSecret` 取自 `pan.wo.cn/bridge.js` 挂到 `window` 的 `obfuscatorAESCodeProd`，
> IV 与 App 相同（固定 16 字节），且 body 必须同时带 `secretType:"clientSecret"` 与**顶层 `clientId`**。

> 上传链路的**真实回归**（真的传一个文件）在有写权限的机器上执行：本项目约定平板只读，
> 不做写操作。平板侧已验证：`GetZoneInfo` 解析到 `hyupload`、缓存生效、
> 两个域名对 `upload2C` 的空请求响应一致（HTTP 400），回退分支已写好。

---

## 五、复现命令

```bash
# 区域信息（本账号返回 hyupload）
node wocloud.mjs raw GetZoneInfo '{"appId":"10000001"}'

# 账号限制
node wocloud.mjs raw QuerySysConfig '{"clientType":"1","application":"WO_PAN","clientId":"1001000021"}'

# 扩展名分类表
node wocloud.mjs raw ClassifyRule '{}'

# 新版直链（与 V1 对比域名）
node wocloud.mjs raw GetDownloadUrlV2 '{"type":"1","fidList":["<fid>"],"clientId":"1001000021"}'

# 家庭空间入口
node wocloud.mjs raw FamilyUserCurrentEncode '{"clientId":"1001000021"}'
```

> 参考仓库已落在本机 `~/workspace/labs/refs/{wopan-sdk-go,rclone}`（rclone 为稀疏检出，
> 只取 `backend/wopan`）。rclone 那份 4681 行的后端注释里有大量实测结论，见
> `docs/usage.md` 第 11、12 条坑。
