# 联通云盘 macOS 客户端 逆向分析报告

> 目标：还原「联通云盘」客户端的私有通信协议，实现可通过 CLI 调用的第三方客户端。
> 分析方式：REA 工具链 + 对 Electron `app.asar` 的静态解包与代码审计，并以真实账号完成端到端验证。
>
> **合规提示**：本报告为互操作性目的的技术研究。使用前请自行确认符合联通云盘用户协议与当地法律法规；请勿用于批量抓取、绕过付费或任何破坏服务的行为。

---

## 1. 结论速览

客户端是标准 Electron 应用，网络层完全由渲染进程 JS 驱动，**没有强混淆**（webpack 保留了可读的模块名与字符串），因此静态分析即可完整还原协议。

核心发现：

| 项目 | 结论 |
| --- | --- |
| 通信模式 | 单一入口 + 业务 key 的「dispatcher」RPC 风格，POST JSON |
| 签名 | `md5(key + resTime + reqSeq + channel + "")`，无密钥参与，仅防重放/防篡改 |
| 加密 | AES-128-CBC / PKCS7，**固定 IV**，密钥为内置 secretKey 或 accessToken |
| 密钥来源 | 硬编码在 `app.js` 中，按平台区分（mac/win/cloud/linux） |
| 鉴权 | accessToken 存于 localStorage，7 天有效 + refreshToken 续期 |
| 结论 | 协议可完整复现，已实现可用的 CLI 并验证通过 |

---

## 2. 目标应用信息

| 字段 | 值 |
| --- | --- |
| 应用名 | 联通云盘 |
| Bundle ID | `com.chinaunicom.bol.cloud` |
| 版本 | 2.8.13 |
| 技术栈 | Electron（macOS）+ Vue 2 + Element UI |
| 开发者 | 联通在线信息科技有限公司 |
| 官网 | https://pan.wo.cn |
| 安装路径 | `/Applications/联通云盘.app` |
| 主进程 | `Contents/Resources/app.asar` → `background.js`（4.2 MB） |
| 渲染层 | `app.asar` → `js/*.js`（109 个 chunk，Vue SPA） |
| 原生依赖 | sqlite3、usb-detection、trash、original-fs |
| 更新源 | `https://pack.pan.wo.cn/download/` |

---

## 3. 应用架构

```
联通云盘.app
├── Contents/MacOS/联通云盘              # Electron 启动器（69 KB）
├── Contents/Frameworks/                  # Electron Framework + Helper 进程
└── Contents/Resources/
    ├── app.asar (46 MB)                  # 应用主体
    │   ├── background.js (4.2 MB)        # 主进程：上传引擎、同步盘、USB、托盘、IPC
    │   ├── preload.js (14 KB)            # 上下文桥（electronAPI）
    │   ├── js/                           # 渲染层 SPA（Vue + Element UI）
    │   │   ├── app.js (843 KB)           # 主 bundle：路由、store、全部业务 API 封装
    │   │   ├── chunk-libs.js (3.1 MB)    # 第三方库（含 CryptoJS、axios）
    │   │   └── chunk-*.js                # 各页面按需加载
    │   ├── index.html
    │   └── node_modules/                 # 打包进 asar 的运行时依赖
    └── app.asar.unpacked/                # 原生模块（.node）
```

**关键分工**：渲染层负责所有 HTTP 业务请求；主进程负责大文件上传引擎、同步盘（macOS FileProvider）、USB 设备检测与本地文件操作。**逆向的重点因此落在 `app.js`**。

---

## 4. 域名清单

| 域名 | 用途 |
| --- | --- |
| `https://panservice.mail.wo.cn` | **主 API 网关**（dispatcher 入口） |
| `https://tjupload.pan.wo.cn` | 文件上传 |
| `https://tjdownload.pan.wo.cn` | 文件下载（签名直链） |
| `https://s.pan.wo.cn` | 静态资源 / CDN |
| `https://f.pan.wo.cn` | 图片、Office 插件图标 |
| `https://b.smartont.net:443` | B 端接口 / 快传（quickTransfer） |
| `https://iotpservice.smartont.net` | IoT 相关 |
| `wss://pre.pan.wo.cn:18070/wsPush` | WebSocket 推送（设备号订阅） |
| `https://panservice.mail.wo.cn:18090/point/v1` | 埋点上报 |
| `https://pan.wo.cn` | Web 端 / H5 |
| `https://cloud.wo.cn` | 官网 |
| `https://pack.pan.wo.cn/download/` | 客户端更新源 |
| `https://apmplus.volces.com` | 火山引擎 APM 监控 |

---

## 5. 通信协议（核心）

### 5.1 dispatcher 模式

所有业务请求都走「一个入口 + 业务 key」的形式。客户端内存在**两个 dispatcher 变体**，区别在 URL、channel 与加密密钥：

| 变体 | 来源模块 | URL | channel | 参数加密密钥 | clientId 位置 |
| --- | --- | --- | --- | --- | --- |
| **api-user** | `f3c4` | `/api-user/dispatcher` | `api-user` | `secretKey` | body 顶层 |
| **wohome** | `a417` | `/wohome/dispatcher` | `wohome` | `accessToken` | 被加密的 params 内 |

> `api-user` 用于账号类接口（登录、用户信息、注册…）；`wohome` 用于网盘文件类接口（列目录、搜索、下载、上传…）。

### 5.2 请求结构

```http
POST https://panservice.mail.wo.cn/{api-user|wohome}/dispatcher
Content-Type: application/json
accesstoken: <accessToken>
Access-Token: <accessToken>
X-YP-Access-Token: <accessToken>
Client-Id: 1001000210
pc-version: 2.8.13
pc-os: mac
Sys-Version: Android/10
platform: 4
```

```jsonc
{
  "header": {
    "key": "QueryAllFiles",        // 业务接口名
    "resTime": 1760000000000,      // Date.now()
    "reqSeq": 123456,              // 100000 ~ 189998 随机
    "channel": "wohome",
    "version": "",
    "sign": "<md5>",
    "accessToken": "<token>"       // 仅 wohome 变体带
  },
  "body": {
    // wohome:  clientId 在被加密的参数内
    // api-user: clientId 在 body 顶层
    "param": "<AES 密文, base64>",
    "clientId": "1001000210",      // api-user 变体
    "secret": true
  }
}
```

### 5.3 签名算法

```js
sign = md5(key + resTime + reqSeq + channel + "").toLowerCase()
```

- 拼接顺序：业务 key → 时间戳 → 请求序号 → channel → version（空串）
- 明文 MD5，**不含任何密钥**，作用仅为防重放/参数一致性校验
- 逆向位置：`app.js` 模块 `625e`（自实现 MD5）与 `f3c4` / `a417`

### 5.4 加解密

逆向位置：`app.js` 模块 `90c5`

```js
const IV = "<固定 16 字节常量>";         // 硬编码固定 IV，非随机

encrypt(plain, key) = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(plain),
    CryptoJS.enc.Utf8.parse(key.length > 16 ? key.slice(0,16) : key),
    { iv: CryptoJS.enc.Utf8.parse(IV), mode: CBC, padding: Pkcs7 }
).toString();                            // → base64 密文

md5(s) = CryptoJS.MD5(s).toString();
```

对应 Node.js 等价实现：

```js
const c = createCipheriv("aes-128-cbc", Buffer.from(key.slice(0,16)), Buffer.from(IV));
Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
```

- 算法：**AES-128-CBC / PKCS7**
- IV：固定 16 字节常量（非随机，因此密文可复现），随客户端一同分发
- 密钥：`secretKey`（api-user）或 `accessToken`（wohome），超长则截断到 16 字节

### 5.5 响应结构

```jsonc
{
  "STATUS": "200",          // 网关状态
  "MSG": "服务调用成功！",
  "LOGID": "...",           // 排障用
  "RSP": {
    "RSP_CODE": "0000",     // 业务码，0000 成功
    "RSP_DESC": "成功",
    "DATA": {}              // 可能是明文对象，也可能是 AES 密文字符串
  }
}
```

`DATA` 为字符串时需解密：**wohome 用 accessToken，api-user 用 secretKey**。

### 5.6 业务错误码（已观测）

| RSP_CODE | 含义 |
| --- | --- |
| `0000` | 成功 |
| `1000` | 请求参数错误（缺字段/字段名不对） |
| `1001` | token 失效 → 触发 refreshToken 流程 |
| `6002/6003` | 短信验证码相关错误 |
| `6006` | 需要图形验证码 |
| `7005/7006` | 密码相关错误 |
| `110001` | 目录相关异常（家庭空间） |

---

## 6. 密钥与客户端标识

来源：`app.js` 模块 `403a`（按 `VUE_APP_SECRET_URL=prod` 取 prod 分支）

本节只说明**密钥从哪来、用在哪、有多长**，不重复列值 —— 这些常量随官方客户端一同分发，
装了客户端的人都能自行取出；本项目运行所需的一份内置在
[`wocloud-core.mjs`](../wocloud-core.mjs) 顶部常量区。

| 用途 | 结构 | 长度 |
| --- | --- | --- |
| `loginTicket` | `dev` / `prod` 各一个 | 16 字符 |
| `cloud` | `dev` / `prod` 各一个 | 16 字符 |
| `win` | `dev` / `prod` 各一个 | 16 字符 |
| `mac` | `dev` / `prod` 各一个 | 16 字符 |
| `linux` | 构建期注入 | — |

- macOS 客户端用 `mac.prod` 作为 `secretKey`，恰好 16 字符，无需截断
- 另有若干硬编码常量（`app.js` 中的 `Fe`）与部分接口专用的密钥对（用于 `/wohome/free/...` 与 B 端接口），取法与上表同源

### 网页端 clientSecret（2026-10-26 新增，分享页实测）

`https://pan.wo.cn/bridge.js` 在加载时往 `window` 上挂 4 个常量（由混淆数组运行时解析）：

| window 变量 | 用途 |
| --- | --- |
| `obfuscatorAESCodeProd` | 网页端 AES 密钥（即 `clientSecret`），16 字符 |
| `obfuscatorAESCodeDev` | 同上，dev 分支 |
| `obfuscatorAESIv` | 与 App 相同的固定 IV |
| `obfuscatorUmengfe` | 埋点标识，24 位十六进制 |

需要取值时打开 `pan.wo.cn`，控制台执行
`Object.keys(window).filter(k => k.startsWith("obfuscator"))` 即可列出。

用法（`chunk-5b6b8a55` 分享页源码）：

```js
// 请求
body = { param: AES(JSON.stringify(param), clientSecret), secret: true, secretType: "clientSecret", clientId }
// 响应：DATA 也用 clientSecret 解密
```

**两个坑**：
1. `clientId` 必须同时出现在 **body 顶层**（`1001000210`），只放进加密参数里会回 `1000 请求参数错误`。
2. 该模式下不带 `accessToken`，是**匿名可读**接口（分享页未登录就能看列表）。

### clientId 对照表

| 值 | 常量名 |
| --- | --- |
| `1001000210` | `VUE_APP_CLOUD_CLIENT_MAC_ID` / `CLOUD_CLIENT_ID` / `CLIENT_ID` |
| `1001001016` | `VUE_APP_CLIENT_ID_FOR_INSIDE_CLOUD_PC` |
| `1001001017` | `VUE_APP_CLIENT_ID_WHEN_BOOT_WITH_TICKET`（亦是 AppRefreshToken 默认值） |
| `1001000021` | `VUE_APP_WEB_CLIENT_ID` |

---

## 7. 接口清单

### 7.1 业务 key（共 63 个，节选分组）

**文件与目录**
`QueryAllFiles` `QueryDirectorys` `QueryTypeFiles` `GetSearchDirectory` `GetDirectoryPath`
`SearchFileV3` `CreateDirectory` `RenameFileOrDirectory` `RecoverVersionFile` `VideoDisplayFiles`

**上传下载**
`GetDownloadUrl` `GetDownloadUrlV2` `/wohome/pass/file/batch/createTask`（删除/移动）
`/wohome/fileVersionDispatcher`

**账号**
`AppQueryUser` `AppLoginByMobile` `PcWebLogin` `PcLoginVerifyCode` `AppLogout` `AppRegisterV2`
`AppUpdateUserV2` `WebUpdateUserInfo` `AppRetrievePasswordV2` `ReSetPwd` `SetPwd` `VerifySetPwd`
`GenerateReSetPwdSignCode` `AppRefreshToken`

**空间与权益**
`QueryFamilyGroups` `MoveInOrOutPrivateSpace` `PrivateSpaceLogin` `FCloudProductPackage`
`FCloudProductOrd` `FCloudProductOrdListQry` `QryFCloudRights` `ReleaseSign` `ProductChg`
`QryFCloudCbProductHisOrders` `FCloudCbProductPackage`

**分享与快传**
`ShareFile` `ShareFileDetail` `QueryShareFiles` `AllShareFileList` `CancelOrDelShareFile`
`FlyPassFileList` `ReceiveFlyPassBatch` `DelFlyPass`

**相册与备份**
`QueryAlbumBackupV2` `QueryAlbumBackupDeviceList` `QueryAlbumBackupByUploadTime`
`QrySysWcFileBackUp` `QueryWjsyBackup` `QueryUserLog` `QuerySysConfig` `GetZoneInfo`
`AcquireSmartAlbumSwitch` `ClassifyRule` `FeedBack` `QryPhoneInfo` `AllDynNews`

### 7.2 已验证可用的接口

| 接口 | 参数 | 说明 |
| --- | --- | --- |
| `AppQueryUser` | `{accessToken}` | 用户信息（走 api-user） |
| `QueryAllFiles` | `{spaceType, parentDirectoryId, pageNum, pageSize}` | 列目录（走 wohome） |
| `SearchFileV3` | `{searchType, keyWord, pageNo, pageSize}` | 搜索；`searchType` 取 `"0"`=全部、`"1"`=家庭 |
| `GetDownloadUrl` | `{fidList: [fid], spaceType}` | 批量取下载直链，返回 `DATA[i].downloadUrl` |
| `CreateDirectory` | `{spaceType, parentDirectoryId, directoryName, deviceNo, clientType:1}` | 新建目录 |
| `/wohome/pass/file/batch/createTask` | 见 7.3 | 删除 / 移动（直连，`clientType` 必须是数字 1） |
| `GetDownloadUrlV2` | `{type:"1", fidList:[fid]}` | 新版直链，返回 `DATA.list[0].downloadUrl`；见 7.9 |
| `GetZoneInfo` | `{appId:"10000001"}` | 账号所属上传区域，返回 `DATA.url`（如 `https://hyupload.pan.wo.cn`） |
| `QuerySysConfig` | `{clientType:"1", application:"WO_PAN", clientId}` | 账号限制：单目录文件数上限、回收站天数、单次选择数 |
| `ClassifyRule` | `{}` | 扩展名 → 文件类型（84 条有效，`type` 1~5） |
| `QueryShareInfo` | `{shareId, shareCode}` | 分享元信息（匿名，clientSecret） |
| `ShareFileDetail` | `{shareId, shareCode}` | 分享内文件列表（匿名，clientSecret）；见 7.8 |

> **坑位记录**：`QueryAllFiles` 用的是 `parentDirectoryId`（不是 `directoryId`）；搜索用的是 `keyWord`（大写 W）且 `searchType="2"` 会报 1000。这些只有读客户端调用点才能确定。

### 7.3 写操作（删除 / 移动 / 重命名 / 建目录）

写操作分属两条不同的链路，**不能混用**：

| 操作 | 接口 | 链路 | 响应结构 |
| --- | --- | --- | --- |
| 删除 / 移动 | `POST /wohome/pass/file/batch/createTask` | 直连（`post` 封装） | `{meta, result}` |
| 重命名 | dispatcher key `RenameFileOrDirectory` | dispatcher | `{STATUS, RSP}` |
| 建目录 | dispatcher key `CreateDirectory` | dispatcher | `{STATUS, RSP}` |

#### 直连链路（`post` 封装）

复刻自 `background.js`：

```js
POST https://panservice.mail.wo.cn{path}
Headers:
  Content-Type: application/json
  X-YP-Access-Token: <accessToken>
  X-YP-Client-Id: <clientId>        // macOS 上即 1001000210
  pc-version: 2.8.13
  pc-os: mac
  accessToken: <accessToken>
Body: 明文 JSON（不加密）
响应: { meta: { code, message }, result: {...} }
```

> ⚠️ **踩坑记录**：`clientType` 必须是**数字** `1`。传字符串（如 `"MAC"`）会被网关直接拒绝，返回 `HTTP 400` 且响应体为空（只有 `X-Request-Id`），非常难排查。

#### 删除 / 移动参数

```jsonc
{
  "taskType": "DELETE" | "MOVE",
  "sourceSpaceType": "0",
  "targetSpaceType": "0",
  "sourceFileIds": ["<文件id>"],        // 操作文件时填
  "sourceDirectoryIds": ["<目录id>"],   // 操作目录时填
  "targetDirectoryId": "<目标目录id>",   // MOVE 时填
  "targetFamilyId": "",
  "sourceFamilyId": "",
  "deviceNo": "<设备号>",
  "clientType": 1,
  "fileVersion": 1,                     // ⚠️ 操作「文件」时必填，缺失会静默失败
  "notEmptyDir": 1                      // 删非空目录时为 1
}
```

> ⚠️ **第二个大坑**：操作**文件**时 `fileVersion` 是**必填**的。缺失或数值不匹配时，接口依然返回 `meta.code = "200"` / `success: true`，但**文件纹丝不动** —— 完全没有错误提示。
> `fileVersion` 可从 `QueryAllFiles` / `SearchFileV3` 返回的 `fileVersion` 字段取得（普通文件通常为 `1`）。
> 操作**目录**时不需要该字段。

响应：

```jsonc
{
  "meta": { "code": "200", "message": "请求成功" },
  "result": {
    "taskId": "...",
    "finish": true,
    "success": true,
    "failMessage": null,
    "wcFileResp": null
  }
}
```

**注意**：删除不存在的 id 也会返回 `success: true`（幂等）。客户端据此判定成功的依据是 `meta.code === "200"`。

#### 建目录参数（dispatcher）

```jsonc
{ "spaceType": "0", "parentDirectoryId": "0", "directoryName": "新目录",
  "deviceNo": "", "clientType": 1 }
```

#### 重命名参数（dispatcher）

```jsonc
{ "spaceType": "0", "type": 0, "id": "<id>", "name": "新名字",
  "deviceNo": "", "clientType": 1 }     // type: 0=目录 1=文件；文件还需 fileVersion
```

### 7.4 其它直连接口（同为 `post` 封装）

| 路径 | 用途 |
| --- | --- |
| `/wohome/fileVersionDispatcher` | 文件版本 / 同步单元设置（`{header:{uri,accessToken}, body}`） |
| `/wohome/open/v1/contactBackup/getKeyAttribute` | 通讯录备份密钥属性 |
| `/wohome/open/v1/contactBackup/applyCert` | 申请证书 |
| `/wohome/open/v1/contactBackup/applyEncryptionBusinessKey` | 申请加密业务密钥 |

### 7.4.1 回收站（dispatcher）

| key | 用途 | 参数 |
| --- | --- | --- |
| `QueryRecycleData` | 列表 | `{spaceType, pageNum, pageSize}` |
| `ReductionRecycleData` | 还原 | `{spaceType, deleteNos: [...]}` |
| `DeleteRecycleData` | 彻底删除 | `{spaceType, deleteNos: [...]}` |
| `EmptyRecycleData` | 清空 | `{spaceType}` |

> 注意参数是 **`deleteNos`**（不是 `idList` / `ids`），值取自列表返回的 `deleteNo` 字段。
> 还原会回到**被删除时所在的父目录**，不是根目录。

列表项字段：`deleteNo` `deleteTime` `fid` `fileSize` `name` `type`(0目录/1文件) `keepDays` `id` `fileType`

> **`keepDays` 只信条目字段**：`QuerySysConfig.vip_level_recycle_bin` 对本账号（`memberLevel=400`）给 7 天，
> 实际条目下发 **15 天**，两者不一致。
>
> **分页不稳定**：`deleteTime` 相同的条目跨页会重复出现（实测 105 条连续翻 20 页得到 2000 条、去重后 105），
> 客户端必须按 `deleteNo` 去重，并「连续两页无新增就停」，不能只看 `pageSize` 是否满页。
>
> **删除文件用 `id` 不是 `fid`**：`/wohome/pass/file/batch/createTask` 传长 `fid` 时接口照样回 `meta.code=200`，
> 但不会真的删除（静默空操作）；传短 `id` 才生效。

### 7.5 容量查询（直连）

```http
POST /api/bff/member/info/card/storage      # 走 post 封装
→ { meta:{code,message}, result:{ usedSpace, allSpace, space:"54.92G/2.00T",
                                  spaceUsageRatio:"2.68%", memberLevel, ... } }
```

### 7.6 其它已定位端点（共 79 个，节选）

**批量重命名**
- `POST /wohome/open/file/batchRename`
- `POST /wohome/open/file/batchRename/result`

**收藏夹**
- `POST /wohome/fileCollect/createTask` / `/list` / `/send/files`
- `GET  /wohome/fileCollect/share/{id}` / `/detail/{id}` / `/delete/{id}`
- `POST /wocloud/favorite/addAndCancelFavorite` / `/wocloud/favorite/list` ⚠️（实测 500，参数待定）

**解压**
- `POST /openapi/file/unzip`
- `POST /openapi/file/getUnzipTask`

**AI 能力**
- `/wohome/ai/agnet/task/convert` · `/list` · `/query` · `/summary` · `/export` · `/rename` · `/delete` · `/modifyContent` · `/getFileInfo`
- `/wohome/ai/conversion/list` · `/detail` · `/delete` · `/rename` · `/clearAll`
- `/wohome/open/assistant/expand/document`
- `/wohome/ai/assistant/stop`

**知识库**
- `wohome/knowledge/list` · `/create` · `/updata` · `/delete` · `/saveFile` · `/queryDetail` · `/queryStatus` · `/reanalyze` · `/deleteDetail` · `/queryKnowledge` · `/queryTypeFileList` · `/aiKnowledgeUsageInfo` · `/uploadCover`

**笔记**
- `/wohome/open/note/text/list` · `/detail` · `/create` · `/update` · `/delete`
- `/wohome/open/note/trash/list` · `/restore` · `/permanentDelete` · `/clear`

**相册**
- `/wohome/v2/album/header` · `/second` · `/detail`

**备份（通讯录/通话/短信）**
- `/wohome/open/v1/contactBackup/getContactBackupRecord` · `/getContactBackupDetail` · `/deleteContactBackupRecord`
- `/wohome/open/v1/callBackup/getCallBackupDetail` · `/deleteCallBackupInfo`
- `/wohome/open/v1/messageBackup/getMessageBackupList` · `/getMessageBackupDetail` · `/deleteMessageBackupDetail`

**其它**
- `/wohome/open/v1/QRCode/generate` · `/query`（扫码登录）
- `/wohome/open/file/exportDirectory` · `/result`
- `/wohome/open/v1/file/transformation/create-task` · `/query-task`
- `/wohome/backup/registerPc`
- `/wohome/free/v1/findClassifyRule`

### 7.7 登录相关端点（非 dispatcher）

| 端点 | 说明 |
| --- | --- |
| `POST /api-user/open/user/login/free` | 免密/开放登录，需 `X-YP-Open-*` 签名头 |
| `POST /api-user/free/v1/login/yHAndYpPcLogin` | PC 扫码/联合登录 |
| `POST /api-user/exchange/token` | 换取 token（`{clientId:"1001000021"}`） |
| `POST /api-user/sendMessageCodeBase` | 发送短信验证码（`func:"pc_send"`，`param` 加密） |
| `GET  /api-user/getverifycode?uuid=` | 获取图形验证码 |

**开放登录签名**（`X-YP-Open-Sign`）：

```js
o = X-YP-Client-Id + X-YP-Open-Timestamp + X-YP-Open-Version
a = "autoRegistry" + autoRegistry
  + (extraInfo 非空 ? "extraInfo" + flattenSortedKeys(extraInfo) : "")
  + "ticket" + ticket
sign = md5(secretKey + o + a + secretKey).toLowerCase()
```

### 7.8 他人分享链接（匿名可读，2026-10-26 实测打通）

**短链 → shareId**

```
GET https://pan.wo.cn/s/<短码>        → 302
Location: https://pan.wo.cn/share_code?clientId=1001000210&shareId=<32hex>[&shareCode=xxxx]
```

⚠️ `Location` **不一定带 `shareCode`**：同账号实测，一条带（`vVzN`）、一条不带。缺码时下游接口只回
`1000 请求参数错误`，不会提示「需要提取码」——所以 `share-ls/share-dl` 要支持手填 `--code`。

**取数据（都是 `clientSecret` 模式，见 §6）**

| 接口 | 参数 | 返回 |
| --- | --- | --- |
| `QueryShareInfo` | `{shareId, shareCode}` | `{nickName, vipLevel, invalidTime, invalid, shareUserId}` |
| `ShareFileDetail` | `{shareId, shareCode}` | 顶层条目数组：`{fid, fileName, fileSize, type, thumbUrl}` |
| `GetDownloadUrlV2` | `{type:"1", fidList:[分享里的 fid]}` | 正常 `token` 模式；**必须登录**，直链按自己账号签发 |

**能力边界（实测）**

- 目录型分享只能拿到目录项，进去需要 `QueryShareFiles` —— 参数未解（`shareId+shareCode` 组合试了
  `parentDirectoryId` / `directoryId` / `fid` / `searchKey` 全部回 1000），待真机抓包补齐。
- 网页端下载同样强制登录（未登录点击会跳 `/login?redirect=/share_files`），所以 `share-dl` 依赖本地凭证。

### 7.9 区域 / 账号配置 / 文件类型（2026-10-26 新增）

| 接口 | 要点 | 本机实测值 |
| --- | --- | --- |
| `GetZoneInfo` | 上传域名按账号分区，不能写死；失败要能回退 | `https://hyupload.pan.wo.cn` |
| `QuerySysConfig` | `vip_level_file_num_limit` 按会员等级给单目录文件数上限；`vip_level_recycle_bin` 给保留天数 | `memberLevel=400`（等级 4）→ 配置 100 个/目录；回收站 7 天。**2026-10-26 PC 实测：101 个同目录上传成功，该值不是硬限制** |
| `ClassifyRule` | `fileTypes[ext] = {subType, ability, type}`，`type` 1~5 直接对应官方分类 | 84 条有效（另有 1 条 `type=7` 空扩展名脏数据，忽略） |
| `GetDownloadUrlV2` | 与 V1 域名通常相同（本机都是 `hydownload`），仅在 V1 抽风时兜底 | `DATA.list[0].downloadUrl` |

> `ClassifyRule` 与内置静态表差异：服务端多覆盖 40 种扩展名（`psd/livp/asf/rm/m3u8/ac3/tta/7z/rar…`）；
> 反向有 12 种只在内置表（`svg/heif/dng/opus/odt/ods/odp/pages/numbers/key/mpeg/mts`），所以实现是
> **服务端优先 + 静态兜底**，而不是直接替换。

---

## 8. 鉴权与本地存储

### 8.1 token 流转

```
登录 → access_token + refresh_token
     → localStorage 持久化（7 天）
     → 每次请求放 HTTP header（accesstoken / Access-Token / X-YP-Access-Token）
     → 业务码 1001 时用 refreshToken 换新 token
```

> **2026-10-26 实测**：`POST /api-user/exchange/token`（带当前 accessToken）返回新 token 后，
> **旧 token 立刻 1001**；连续 exchange 3 轮均成立 → 可无限接力，但同一时刻只能有一份有效 token。
> 因此多设备必须单点续期（本项目由 VPS 的 `token-keeper` 独占，设备只拉取）。

刷新逻辑（`app.js` 模块 `0c6d`）：

```js
params = { clientId, clientSecret: secretKey, refreshToken }
body   = { param: AES(JSON.stringify(params), secretKey) }
调用 AppRefreshToken（clientId 默认 1001001017）
成功 → 写回 access_token / refresh_token
```

### 8.2 本地存储位置

macOS 路径：`~/Library/Application Support/wocloud/`

| 键 | 含义 |
| --- | --- |
| `WoCloud-Web-Token` | accessToken |
| `WoCloud-Web-Token_expiredate` | 过期时间戳（签发 +7 天） |
| `WoCloud-Web-Refresh-Token` | refreshToken |
| `WoCloud-Web-User-Info` | 用户信息缓存 |
| `WoCloud-Web-Vip-Info` | 会员信息 |
| `WoCloud-Web-Usage-Info` | 容量使用 |
| `WoCloud-Web-User_Privilege-Info` | 权益信息 |

存放于 `Local Storage/leveldb/`，记录格式为 `<key><varint 长度><编码前缀 0x00=UTF16LE / 0x01=Latin1><值>`。
另有 `config.json`（`lastMacUserId`、`settingInfo`）与 macOS `SharedDefaults`（供 FileProvider 扩展读取）。

**CLI 因此可以免登录复用已登录会话** —— 直接读取上述 leveldb 即可拿到 accessToken。

---

## 9. 上传与下载

### 9.1 上传（主进程实现，`background.js`）

> **文件名规则（2026-10-26 补录，来源 rclone 后端 probe 注释）**：服务端对叶子名有硬限制——
> 超过 100 个字符会被**静默截断**（不报错，等于换了文件名）；非 BMP 字符（如 😀）回裸 HTTP 500；
> BMP emoji 象形符（© ® ™ ❤ ☀…）回 `RSP_CODE 1009 名称中含有非法字符`，整个路径被拒。
> CLI 已在上传前预检，见 `docs/techniques.md` 第 1 条。

#### 配置常量

```js
{
  CHUNK_SIZE: 16777216,              // 16 MB 分片
  SMALL_FILE_LIMIT: 3145728,         // 3 MB 以下走单分片直传
  MAX_CONCURRENT_CHUNKS: 3,
  MAX_CONCURRENT_FILES: 5,
  PROGRESS_NOTIFY_INTERVAL: 500,
  MAX_RETRY_COUNT: 3,
  RETRY_DELAY: 5000,
  READ_STREAM_BUFFER_SIZE: 4194304,  // 4 MB
  DEFAULT_UPLOAD_SERVER: "https://tjupload.pan.wo.cn",
  UPLOAD_API_PATH: "/openapi/client/upload2C",
  QUICK_TRANSFER_API: "https://b.smartont.net:443/openapi/transfer/quickTransfer"
}
```

#### 完整流程

```
1. 读取文件大小 → totalPart = ceil(fileSize / 16MB)
2. 计算 SHA256（流式，64KB 块）
3. 秒传检查 quickTransfer —— 命中则直接完成，无需上传
4. 未命中 → 逐片上传（最多 3 并发，失败指数退避重试 3 次）
5. 最后一片的响应中返回 fid
```

#### 步骤 3：秒传检查

```http
POST https://b.smartont.net:443/openapi/transfer/quickTransfer
access-token: <accessToken>
Content-Type: application/json
```

```jsonc
{
  "sha256": "<文件 SHA256>",
  "fileSize": 20971520,
  "fileName": "demo.bin",
  "fileType": "5",              // 0=全部 1=图片 2=视频 3=音频 4=文档 5=其它
  "batchNo": "20261014160235",  // YYYYMMDDHHmmss
  "spaceType": "0",
  "directoryId": "0",
  "fileModificationTime": 1760000000000   // 毫秒
}
```

响应 `{ meta: {code, message}, result: { hasFile: 1 } }`：
- `meta.code === "0000"` 且 `result.hasFile === 1` → **文件已存在，秒传成功**
- `meta.code === "2001"` → 云盘容量不足

> 实测：同一文件重复上传时 `hasFile` 未必为 1（服务端去重索引策略），因此秒传是**优化路径**而非可靠路径，未命中时照常分片上传即可。

#### 步骤 4：分片上传

```http
POST https://tjupload.pan.wo.cn/openapi/client/upload2C
Content-Type: multipart/form-data
```

| 表单字段 | 值 |
| --- | --- |
| `accessToken` | accessToken |
| `uniqueId` | 本次上传的 UUID（同一文件所有分片共用） |
| `fileName` | 文件名 |
| `fileSize` | 文件总大小（字节） |
| `totalPart` | 分片总数 |
| `partSize` | **本片**大小（字节） |
| `partIndex` | **本片序号，从 1 开始** |
| `channel` | `"wocloud"` |
| `directoryId` | 目标目录 id |
| `fileInfo` | **AES(JSON, accessToken)** ← 加密字段 |
| `file` | 分片二进制数据 |

`fileInfo` 解密后的内容：

```jsonc
{
  "batchNo": "20261014160235",
  "fileName": "demo.bin",
  "fileSize": 20971520,
  "fileType": "5",
  "directoryId": "0",
  "spaceType": "0",
  "deviceNo": ""
  // spaceType=1 时加 familyId；spaceType=4 时加 psToken
}
```

响应：

```jsonc
{ "code": "0000", "msg": "...", "data": { "fid": "<文件唯一标识>" } }
```

- `code === "0000"` 成功；`"2001"` 容量不足
- `fid` 用于后续下载（`GetDownloadUrl` 的 `fidList`）

> 与 dispatcher 不同，这里返回的是**扁平的 `{code, msg, data}`**，不是 `{STATUS, RSP}`。

#### 完整性验证

实测 20 MB 随机数据（2 个分片：16 MB + 4 MB）上传后下载回来比对：

```
本地原文件 SHA256: e9ac06141cc08a571b9cdc8938d89609e5222e46c03188661a90740107056e26
下载回来后 SHA256: e9ac06141cc08a571b9cdc8938d89609e5222e46c03188661a90740107056e26
✅ 完全一致
```

### 9.2 下载

```
GetDownloadUrl({fidList:[fid], spaceType})
  → DATA[i].downloadUrl
  → https://tjdownload.pan.wo.cn/openapi/download?fid=<带签名的 fid>
```

直链有效期较长（响应头 `cache-control: max-age=31536000`），可直接用 HTTP 客户端下载。

> **2026-10-26 修正**：直链并非长期有效——rclone 后端实测 **120 分钟到期且不随访问滑动**
> （`519` 自然过期 / `518` URL 被篡改 / `403` 撤销）。CLI 已内置换链续传。
>
> 取链有两条通道：V1 `GetDownloadUrl`（App 现行）与 V2 `GetDownloadUrlV2`（网页/新版）。
> 两者返回域名通常相同，CLI 采用 **V1 优先、失败自动退 V2**，`--api v2` 可强制首选。

---

## 10. CLI 实现与验证结果

实现文件：`wocloud-cli/wocloud-cli.mjs`（零依赖，仅用 Node 内置模块）。

已实现命令：`whoami` / `usage` / `ls` / `tree` / `find` / `download` / `upload` / `mirror` /
`mkdir` / `rename` / `rm` / `mv` / `trash` / `restore` / `purge` / `empty-trash` / `post` / `raw`。

### 实测结果（真实账号）

| 命令 | 结果 |
| --- | --- |
| `whoami` | ✅ `RSP_CODE=0000`，返回 userId / userName / 注册时间 |
| `usage` | ✅ `54.92G/2.00T (2.68%)`，带进度条 |
| `ls` / `ls --dir` | ✅ 正常返回目录内容 |
| `tree --depth 12` | ✅ 全盘 186 目录 / 3893 文件 / 43.30 GB |
| `find 文档` | ✅ 命中 `文档1.doc`（207,872 字节） |
| `download <fid> --out` | ✅ 下载得到合法文件（文件头校验通过） |
| `upload`（小文件） | ✅ 44 B 上传成功 |
| `upload`（多分片） | ✅ 20 MB → 2 分片，回下载 **SHA256 一致** |
| `upload`（并发） | ✅ 50 MB → 4 分片并发 3，5.9 秒，回下载 **SHA256 一致** |
| `mirror` | ✅ 33 文件 12.07 MB；二次运行全跳过；删 1 个只补 1 个 |
| `mkdir` | ✅ 创建目录成功 |
| `rename --dir --yes` | ✅ 重命名成功并验证 |
| `mv --yes` | ✅ 移入目标目录，`ls` 验证位置正确 |
| `rm --dir --yes` | ✅ 删除目录成功 |
| `rm --version 1 --yes` | ✅ 删除文件成功（**不带 `--version` 会静默失败**） |
| `trash` | ✅ 列出回收站（含删除时间、剩余保留天数、deleteNo） |
| `restore --yes` | ✅ 还原成功，回到原父目录 |
| `purge --yes` | ✅ 彻底删除成功 |
| `empty-trash` | ✅ 预演模式正确拦截 |

**完整往返验证**：
- 写操作：建目录 → 重命名 → 移动 → 预演删除 → 真删 → 回收站还原 → 彻底清除，全程无残留
- 上传：20 MB / 50 MB 上传后下载回来 SHA256 比对一致（含并发分片）

---

## 11. 关于 REA 工具链

本次分析使用仓库 `morluto/rea`（REA v6.4.0）作为逆向工具链。

| 环节 | 状态 |
| --- | --- |
| 仓库克隆 + 5 个子模块 | ✅ 完成 |
| `npm install` + `npm run compile` | ✅ 完成，`dist/` 产出正常 |
| CLI 可用性（`rea --help` / `doctor`） | ✅ 正常 |
| `rea analyze-javascript-application` | ⚠️ 受运行环境限制未完成 |

**限制说明**：REA 的 JS 分析器会为每个源文件拉起独立 V8 worker 并在结束后清理临时资源。在当前沙箱环境中，worker 的临时目录清理被文件系统代理拦截，导致命令以 `cleanup_incomplete` 退出（即便只分析 `preload.js` 这种 14 KB 文件也一样）。这是**环境限制而非工具缺陷** —— 在普通终端下执行同样命令应当可以完成。

因此本报告的主体结论来自：**对 `app.asar` 的直接解包**（自写 asar 解析脚本，不随仓库提供）+ 对 `app.js` / `background.js` 的定向代码审计 + **真实接口验证**。

---

## 12. 风险与合规提示

1. **服务条款**：使用私有 API 构建第三方客户端可能违反联通云盘用户协议，账号存在被限制的风险。
2. **密钥与协议随时可变**：本报告基于 2.8.13；客户端升级后 `secretKey`、IV、签名方式均可能调整。
3. **accessToken 等同账号凭证**：localStorage 中的 token 可直接操作账号数据，切勿泄露或写入版本库。
4. **上传未验证**：上传链路涉及分片、秒传哈希与并发控制，本次未做端到端验证，CLI 暂未实现。
5. **用途边界**：仅建议用于个人账号的数据备份/迁移等互操作性场景。
