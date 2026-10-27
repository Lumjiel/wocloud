/**
 * wocloud-core.mjs — 联通云盘核心能力（零依赖，唯一真源）
 *
 * 供 wocloud.mjs（CLI）与 mcp/server.mjs（MCP Server）共用。
 * 复现「联通云盘」客户端 v2.8.13 的私有 API 调用链。
 *
 *   - 账号 API  https://panservice.mail.wo.cn/api-user/dispatcher  (channel=api-user)
 *   - 网盘 API  https://panservice.mail.wo.cn/wohome/dispatcher    (channel=wohome)
 *   - 上传 API  https://tjupload.pan.wo.cn/openapi/client/upload2C
 *   - 秒传 API  https://b.smartont.net/openapi/transfer/quickTransfer
 *   - 签名      sign = md5(key + resTime + reqSeq + channel + "")
 *   - 加密      AES-128-CBC / PKCS7，固定 IV "wNSOYIB1k1DjY5lA"
 *
 * token 解析链（跨设备核心，三端行为一致）：
 *   显式参数 → WOCLOUD_TOKEN 环境变量 → 本机客户端 leveldb（桌面端甜点）
 *   → ~/.wocloud/credentials.json（跨设备可复制：Mac 上 `wocloud token --save`
 *   后把文件拷到 Windows/Termux 的同路径即可免登录）
 *
 * token 刷新：业务码 1001 时自动走「exchange 换新 → refreshToken 换新」两级续期，
 * 新 token 持久化回 credentials.json，并原地重试一次原请求。
 */

import { createHash, createCipheriv, createDecipheriv } from "node:crypto";
import {
  readFileSync, readdirSync, existsSync, writeFileSync,
  mkdirSync, statSync, createReadStream, unlinkSync,
  openSync, readSync, closeSync, writeSync, ftruncateSync, chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// ---------------------------------------------------------------- 常量

export const BASE_API = "https://panservice.mail.wo.cn";
export const UPLOAD_API = "https://tjupload.pan.wo.cn";
export const UPLOAD_PATH = "/openapi/client/upload2C";
export const CHUNK_SIZE = 16 * 1024 * 1024;
export const SMALL_FILE_LIMIT = 3 * 1024 * 1024;
export const AES_IV = "wNSOYIB1k1DjY5lA";

/** 网页端 clientSecret（分享页等匿名 visible 接口用它做 AES 密钥，来源：pan.wo.cn/bridge.js + SDK 文档） */
export const CLIENT_SECRET = "XFmi9GS2hzk98jGX";

// 客户端内置密钥表（来源：app.js 模块 403a，取 prod 分支）
export const SECRETS = {
  mac: "32QXmaEWaI5H56l5",
  win: "s72g2VY46ahlK588",
  cloud: "9v5S25F2k7JUSrC9",
  loginTicket: "n5RPfc4M3H6Mmk8C",
  linux: "",
};

export const CLIENT_IDS = {
  mac: "1001000210",
  cloud: "1001000210",
  web: "1001000021",
  insideCloudPc: "1001001016",
  bootWithTicket: "1001001017",
};

export const APP_VERSION = "2.8.13";

// 各平台官方客户端的 leveldb 位置（Electron userData/Local Storage/leveldb）
// 按存在性逐个探测，桌面端（Mac/Windows）装了客户端即可免配置
export const CLIENT_LS_DIRS = [
  join(homedir(), "Library/Application Support/wocloud/Local Storage/leveldb"),
  join(homedir(), "AppData", "Roaming", "wocloud", "Local Storage", "leveldb"),
];
export const MAC_LS_DIR = CLIENT_LS_DIRS[0];   // 兼容旧名

// 跨设备凭证文件（token --save 产出，可整体复制到其他设备）
export const CREDS_DIR = join(homedir(), ".wocloud");
export const CREDS_FILE = join(CREDS_DIR, "credentials.json");
/** relay 连接信息（url + key），配了它就等于「服务器托管续期」模式 */
export const RELAY_FILE = join(CREDS_DIR, "relay.json");

// ---------------------------------------------------------------- 工具

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

function aesKey(secret) {
  return secret.length > 16 ? secret.slice(0, 16) : secret;
}

/** AES-128-CBC 加密，返回 base64（等价客户端 CryptoJS AES.encrypt(...).toString()） */
export function aesEncrypt(plain, secret) {
  const key = Buffer.from(aesKey(secret), "utf8");
  const iv = Buffer.from(AES_IV, "utf8");
  const c = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

/** AES-128-CBC 解密（入参为 base64） */
export function aesDecrypt(cipherB64, secret) {
  const key = Buffer.from(aesKey(secret), "utf8");
  const iv = Buffer.from(AES_IV, "utf8");
  const d = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([
    d.update(Buffer.from(cipherB64, "base64")),
    d.final(),
  ]).toString("utf8");
}

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(2)} ${u[i]}`;
}

// ---------------------------------------------------------------- token 层

/**
 * 解析一条 leveldb 记录的值
 * （记录格式：<key><varint 长度><编码前缀 0x00=UTF16LE / 0x01=Latin1><值>）
 * ⚠️ 严格校验：前缀必须 0x00/0x01、值必须是无空白可打印 ASCII —— 否则大概率是
 *    匹配到了别的 key 的子串（如 WoCloud-Web-Token_expiredate）产生的垃圾。
 */
function parseLeveldbValue(buf, idx, keyLen) {
  let p = idx + keyLen;
  let len = 0, shift = 0;
  while (p < buf.length) {
    const b = buf[p++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (len <= 0 || len > 512 || p + len > buf.length) return null;
  const prefix = buf[p];
  if (prefix !== 0x00 && prefix !== 0x01) return null;
  const payload = buf.slice(p + 1, p + len);
  const raw = prefix === 0x00
    ? payload.toString("utf16le")
    : payload.toString("latin1");
  const v = raw.trim().replace(/^"|"$/g, "");
  // 真 token 是无空白的可打印 ASCII（UUID 或 JWT 形态）；垃圾里通常有 '{' 空格换行
  return /^[!-~]{8,512}$/.test(v) ? v : null;
}

/**
 * 从官方客户端 leveldb 读 token 对（accessToken + refreshToken）。
 * ⚠️ 同一 key 在 leveldb 里可能有多个历史版本（旧值不会立即清除），
 *    必须取文件内【最后一次】出现（写入按时间追加），文件间按 mtime 新者优先。
 * 返回 { accessToken, refreshToken } 或 null
 */
export function readClientTokens() {
  try {
    for (const dir of CLIENT_LS_DIRS) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir)
        .filter((f) => /\.(log|ldb)$/.test(f))
        .map((f) => {
          const p = join(dir, f);
          return { p, m: statSync(p).mtimeMs };
        })
        .sort((a, b) => b.m - a.m);
      const out = { accessToken: null, refreshToken: null };
      const want = {
        accessToken: Buffer.from("WoCloud-Web-Token", "utf8"),
        refreshToken: Buffer.from("WoCloud-Web-Refresh-Token", "utf8"),
      };
      for (const { p } of files) {
        const buf = readFileSync(p);
        for (const [name, keyBuf] of Object.entries(want)) {
          if (out[name]) continue;
          let idx = buf.lastIndexOf(keyBuf);
          while (idx !== -1) {
            const v = parseLeveldbValue(buf, idx, keyBuf.length);
            if (v) { out[name] = v; break; }
            idx = buf.lastIndexOf(keyBuf, idx - 1);
          }
        }
        if (out.accessToken && out.refreshToken) break;
      }
      if (out.accessToken) return out;
    }
  } catch { /* ignore */ }
  return null;
}

/** 兼容旧名：只取 accessToken */
export function readTokenFromClient() {
  return readClientTokens()?.accessToken || null;
}

export function loadCredentials() {
  try {
    if (!existsSync(CREDS_FILE)) return null;
    const j = JSON.parse(readFileSync(CREDS_FILE, "utf8"));
    return j?.accessToken ? j : null;
  } catch { return null; }
}

export function saveCredentials(creds) {
  try {
    mkdirSync(CREDS_DIR, { recursive: true });
    writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
    return true;
  } catch { return false; }
}

/** 进程内活跃会话（resolveSession 命中 client/file 源时建立，刷新后原地更新） */
let activeSession = null;

/**
 * 解析当前会话（跨设备核心逻辑，按优先级取第一个可用的）：
 *   arg → env → ~/.wocloud/credentials.json → 客户端 leveldb
 * credentials.json 优先于 leveldb：它只因用户显式动作（login / token --save /
 * 首次蹭到 leveldb 会话时自动落盘）而存在，一旦存在就由自动刷新持续保活，
 * `login` 换的新会话也因此能立即生效。
 * 返回 { accessToken, refreshToken, source } 或 null
 */
export function resolveSession(explicit) {
  const fileCreds = loadCredentials();
  let s = null;
  if (explicit) {
    s = { accessToken: explicit, refreshToken: fileCreds?.refreshToken || null, source: "arg" };
  } else if (process.env.WOCLOUD_TOKEN) {
    const t = process.env.WOCLOUD_TOKEN;
    s = { accessToken: t, refreshToken: fileCreds?.refreshToken || null, source: "env" };
  } else if (fileCreds) {
    s = { ...fileCreds, source: "file" };
  } else {
    const client = readClientTokens();
    if (client?.accessToken) {
      s = {
        accessToken: client.accessToken,
        refreshToken: client.refreshToken || null,
        source: "client",
      };
      // 顺手落盘一份：刷新后的新 token 才有地方写，其他设备也能直接复制
      saveCredentials({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken || null,
        savedAt: Date.now(),
      });
    }
  }
  if (s && (s.source === "client" || s.source === "file")) activeSession = s;
  return s;
}

/** 兼容旧接口：返回 accessToken 字符串或 null */
export function resolveToken(explicit) {
  return resolveSession(explicit)?.accessToken || null;
}

/** 掩码展示用 */
/** 读取本机 relay 配置；没有或格式不对返回 null */
export function loadRelayConfig() {
  if (!existsSync(RELAY_FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(RELAY_FILE, "utf8"));
    if (typeof j?.url === "string" && typeof j?.key === "string" && j.url && j.key) {
      return { url: j.url.replace(/\/+$/, ""), key: j.key };
    }
  } catch { /* 忽略坏文件 */ }
  return null;
}

export function saveRelayConfig({ url, key }) {
  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(RELAY_FILE, JSON.stringify({ url: String(url).replace(/\/+$/, ""), key: String(key) }, null, 2), { mode: 0o600 });
  try { chmodSync(RELAY_FILE, 0o600); } catch { /* Windows 忽略 */ }
}

/** 从 relay 取当前最新 token；失败返回 null（调用方决定怎么报错） */
export async function pullRelayToken(cfg = loadRelayConfig()) {
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.url}/credentials`, {
      headers: { "X-Relay-Key": cfg.key },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.accessToken === "string" && j.accessToken ? j : null;
  } catch {
    return null;
  }
}

export function maskToken(t) {
  if (!t) return "(无)";
  return t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} 字符)` : t;
}

// ---- 刷新：两条路，前者实证有效，后者是 token 彻底失效时的兜底 ----

/** 路径①：POST /api-user/exchange/token —— 用当前 token 换新（抓包实证，2026-10-14） */
export async function refreshToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${BASE_API}/api-user/exchange/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accesstoken: token, "Access-Token": token, "X-YP-Access-Token": token,
        "X-YP-Client-Id": CLIENT_IDS.mac,
        "pc-version": APP_VERSION,
        "pc-os": "mac",
      },
      body: JSON.stringify({ clientId: CLIENT_IDS.web }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json();
    return j?.RSP?.DATA?.accessToken || null;
  } catch { return null; }
}

/** 路径②：AppRefreshToken（api-user dispatcher）—— accessToken 彻底失效时用 refreshToken 换新 */
export async function refreshByRefreshToken(refreshToken, secretKey = SECRETS.mac) {
  if (!refreshToken) return null;
  try {
    const res = await dispatch("AppRefreshToken", {
      clientId: CLIENT_IDS.bootWithTicket,
      clientSecret: secretKey,
      refreshToken,
    }, { profile: "user", autoRefresh: false });
    return res?.RSP?.DATA?.accessToken
      ? { accessToken: res.RSP.DATA.accessToken, refreshToken: res.RSP.DATA.refreshToken || null }
      : null;
  } catch { return null; }
}

function persistRefresh(accessToken, newRefreshToken) {
  const prev = loadCredentials() || {};
  saveCredentials({
    accessToken,
    refreshToken: newRefreshToken || prev.refreshToken || null,
    savedAt: Date.now(),
  });
  if (activeSession) {
    activeSession.accessToken = accessToken;
    if (newRefreshToken) activeSession.refreshToken = newRefreshToken;
  }
}

let refreshInflight = null;

/**
 * 刷新会话（单飞：并发请求同时撞到 1001 时只发一次刷新）
 * @returns {Promise<{accessToken, refreshToken?, via:string}|null}
 */
export function refreshSession(current) {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    // 配了 relay：服务器是唯一续期者。本地刷新会立刻作废服务器那份（互踢，实测 3/3），
    // 所以这里只拉最新 token；拉不到就返回 null，让调用方看到明确的 1001。
    const relay = loadRelayConfig();
    if (relay) {
      const pulled = await pullRelayToken(relay);
      if (pulled?.accessToken && pulled.accessToken !== current?.accessToken) {
        persistRefresh(pulled.accessToken, current?.refreshToken);
        return { accessToken: pulled.accessToken, refreshToken: current?.refreshToken, via: "relay" };
      }
      return null;
    }
    // 先试 exchange（只需当前 token），不行再用 refreshToken 兜底
    const t = await refreshToken(current?.accessToken);
    if (t) {
      persistRefresh(t, current?.refreshToken);
      return { accessToken: t, refreshToken: current?.refreshToken, via: "exchange" };
    }
    const r = await refreshByRefreshToken(current?.refreshToken);
    if (r?.accessToken) {
      persistRefresh(r.accessToken, r.refreshToken);
      return { accessToken: r.accessToken, refreshToken: r.refreshToken || current?.refreshToken, via: "refreshToken" };
    }
    return null;
  })().finally(() => { refreshInflight = null; });
  return refreshInflight;
}

// ---------------------------------------------------------------- 核心请求

function buildHeaders(token, clientId) {
  const h = {
    "Content-Type": "application/json",
    "pc-version": APP_VERSION,
    "pc-os": "mac",
    "Sys-Version": "Android/10",
    platform: "4",
    "Client-Id": clientId,
  };
  if (token) {
    h["accesstoken"] = token;
    h["Access-Token"] = token;
    h["X-YP-Access-Token"] = token;
  }
  return h;
}

/**
 * 调用业务 dispatcher
 *
 *   profile "user"   POST /api-user/dispatcher  channel="api-user"  用 secretKey 加密
 *   profile "wohome" POST /wohome/dispatcher    channel="wohome"    用 accessToken 加密
 *
 * 响应结构：{STATUS, RSP:{RSP_CODE, RSP_DESC, DATA}}，DATA 解密后为对象。
 * 业务码 1001（token 失效）时自动刷新并重试一次（opts.autoRefresh = false 关闭）。
 */
export async function dispatch(key, params = {}, opts = {}) {
  const clientId = opts.clientId || CLIENT_IDS.mac;
  const secretKey = opts.secretKey || SECRETS.mac;
  const token = opts.token;
  const isUser = (opts.profile || "wohome") === "user";
  // 网页分享页用 clientSecret 加密（匿名可见），不依赖登录 token
  const clientSecretMode = opts.secretType === "clientSecret";

  const channel = isUser ? "api-user" : "wohome";
  const url = `${BASE_API}${isUser ? "/api-user/dispatcher" : "/wohome/dispatcher"}`;
  const encKey = clientSecretMode ? CLIENT_SECRET : (isUser ? secretKey : token);

  const resTime = Date.now();
  const reqSeq = Math.floor(Math.random() * 89999) + 100000;
  const sign = md5(`${key}${resTime}${reqSeq}${channel}${""}`);

  const header = { key, resTime, reqSeq, channel, sign, version: "" };
  if (!isUser && token && !clientSecretMode) header.accessToken = token;

  let body;
  if (isUser) {
    body = {
      param: aesEncrypt(JSON.stringify(params), encKey),
      clientId,
      secret: true,
    };
  } else {
    body = {
      param: aesEncrypt(JSON.stringify({ ...params, clientId }), encKey),
      secret: true,
    };
    if (clientSecretMode) {
      body.secretType = "clientSecret";
      body.clientId = clientId;      // 网页端把 clientId 放在 body 顶层（不在加密参数里也会失败）
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(token, clientId),
    body: JSON.stringify({ header, body }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { return { _httpStatus: res.status, _raw: text }; }

  const rsp = data?.RSP;
  if (rsp && typeof rsp.DATA === "string" && rsp.DATA.length > 0) {
    for (const k of [encKey, secretKey, token]) {
      if (!k) continue;
      try { rsp.DATA = JSON.parse(aesDecrypt(rsp.DATA, k)); break; }
      catch { /* 试下一个 */ }
    }
  }

  // token 失效 → 刷新后原地重试一次（wohome 的加密密钥就是 token，必须换新重加密）
  if (rsp?.RSP_CODE === "1001" && token && opts.autoRefresh !== false) {
    const fresh = await refreshSession({
      accessToken: token,
      refreshToken: opts.refreshToken ?? activeSession?.refreshToken ?? null,
    });
    if (fresh?.accessToken && fresh.accessToken !== token) {
      // 有些接口（如 AppQueryUser）把 accessToken 放在加密参数里，重试时必须一起换，
      // 否则会拿旧 token 再撞一次 1001（实测：whoami 首次必失败、第二次才成功）。
      const p2 = params && typeof params === "object" && params.accessToken === token
        ? { ...params, accessToken: fresh.accessToken }
        : params;
      return dispatch(key, p2, {
        ...opts, token: fresh.accessToken,
        refreshToken: fresh.refreshToken, autoRefresh: false,
      });
    }
    // 刷新也救不活 → 试本机客户端 leveldb（客户端可能自己续过命），最后挣扎一次
    const client = readClientTokens();
    if (client?.accessToken && client.accessToken !== token) {
      const p3 = params && typeof params === "object" && params.accessToken === token
        ? { ...params, accessToken: client.accessToken }
        : params;
      return dispatch(key, p3, {
        ...opts, token: client.accessToken,
        refreshToken: client.refreshToken, autoRefresh: false,
      });
    }
  }
  return data;
}

/**
 * 调用 panservice 的 /wohome/... 直连接口（明文 JSON，响应 {meta, result}）
 * 注意：clientType 必须是数字 1，传字符串会得到 HTTP 400（网关拒绝）
 */
export async function postApi(path, data, opts = {}) {
  const clientId = opts.clientId || CLIENT_IDS.mac;
  const token = opts.token;
  const res = await fetch(`${BASE_API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-YP-Access-Token": token,
      "X-YP-Client-Id": clientId,
      "pc-version": APP_VERSION,
      "pc-os": "mac",
      accessToken: token,
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _httpStatus: res.status, _raw: text }; }
}

// ---------------------------------------------------------------- 扫码登录
// 逆向自客户端：模块 2934（Ab/zb 封装）+ chunk-34bb265a（登录组件：2s 轮询 / 60s 换码）
// 两个端点均为明文 {meta,result}，无需登录态（2026-10-25 未登录直连实测通过）

const QR_HEADERS = {
  "Content-Type": "application/json",
  "client-id": CLIENT_IDS.mac,
  "X-YP-Client-Id": CLIENT_IDS.mac,
};

/** 生成登录二维码：返回 { image: base64 PNG, uuid } */
export async function qrGenerate() {
  const res = await fetch(`${BASE_API}/wohome/open/v1/QRCode/generate`, {
    headers: QR_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json().catch(() => null);
  if (j?.meta?.code !== "200" || !j?.result?.image) {
    throw new Error(`获取二维码失败: ${j?.meta?.message || `HTTP ${res.status}`}`);
  }
  return j.result;
}

/**
 * 查询扫码状态：返回 { state, token, refreshToken }
 *   state: 1=待扫 2=已扫待确认 3=已确认（token/refreshToken 就绪）4=已过期
 */
export async function qrQuery(uuid) {
  const res = await fetch(
    `${BASE_API}/wohome/open/v1/QRCode/query?uuid=${encodeURIComponent(uuid)}`,
    { headers: QR_HEADERS, signal: AbortSignal.timeout(15_000) },
  );
  const j = await res.json().catch(() => null);
  if (j?.meta?.code !== "200") {
    throw new Error(`查询扫码状态失败: ${j?.meta?.message || `HTTP ${res.status}`}`);
  }
  return j.result;
}

// ---------------------------------------------------------------- 上传

export const DEFAULT_CONCURRENCY = 6;   // 实测甜点：6 并发约 19.7 MB/s
export const DEFAULT_FILE_CONCURRENCY = 5;
export const GLOBAL_MAX_INFLIGHT = 8;
export const MAX_RETRY = 3;
const QUICK_TRANSFER_API = "https://b.smartont.net:443/openapi/transfer/quickTransfer";

// 上传区域：官方客户端按账号返回的 zone 上传（tj / hy / gx …），
// 硬编码单一区域在换区后可能整条链路失败。首次上传前解析一次并缓存，
// 失败或返回异常时回退到默认 tjupload。
let _uploadServer = null;

export function getUploadServer() {
  return _uploadServer || UPLOAD_API;
}

export async function resolveUploadServer(opts = {}) {
  if (_uploadServer) return _uploadServer;
  try {
    const res = await dispatch("GetZoneInfo", { appId: "10000001" }, opts);
    const url = res?.RSP?.DATA?.url;
    if (typeof url === "string" && /^https:\/\/[a-z0-9.-]+\.pan\.wo\.cn$/i.test(url)) {
      _uploadServer = url;
    }
  } catch {
    // 取不到就用默认值，不阻塞上传
  }
  return getUploadServer();
}

/** 账号系统配置（会员等级对应的单目录文件数上限、回收站保留天数等） */
export async function querySysConfig(opts = {}) {
  const res = await dispatch("QuerySysConfig", {
    clientType: "1", application: "WO_PAN", clientId: CLIENT_IDS.mac || "1001000021",
  }, opts);
  const cfg = res?.RSP?.DATA?.config;
  if (!cfg || typeof cfg !== "object") throw new Error("QuerySysConfig 返回为空");
  return cfg;
}

// ---------------------------------------------------------------- 分享（他人链接，匿名可读）

/** 网页分享页的 clientId（短链 302 会带，缺省用它） */
const SHARE_CLIENT_ID = "1001000210";

/**
 * 解析分享链接 → { shareId, shareCode, clientId }
 * 支持：https://pan.wo.cn/s/XXXX、裸短码、32 位 shareId；提取码可用 code 参数补。
 */
export async function resolveShareLink(input, code) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("分享链接为空");
  const m = raw.match(/\/s\/([A-Za-z0-9]+)/);
  if (!m) {
    if (/^[a-f0-9]{32}$/i.test(raw)) return { shareId: raw, shareCode: code || null, clientId: SHARE_CLIENT_ID };
    throw new Error("看不懂这个分享链接（应形如 https://pan.wo.cn/s/1AbCdE2F345 或 32 位 shareId）");
  }
  const shortCode = m[1];
  const res = await fetch(`https://pan.wo.cn/s/${shortCode}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const loc = res.headers.get("location") || "";
  const u = new URL(loc, "https://pan.wo.cn");
  const shareId = u.searchParams.get("shareId");
  if (!shareId) throw new Error(`短链解析失败（HTTP ${res.status}，Location: ${loc || "空"}），分享可能已被删除`);
  return {
    shareId,
    shareCode: code || u.searchParams.get("shareCode") || null,
    clientId: u.searchParams.get("clientId") || SHARE_CLIENT_ID,
  };
}

/** 分享元信息（匿名，clientSecret 加密） */
export async function shareInfo(input, code) {
  const s = await resolveShareLink(input, code);
  const opts = { secretType: "clientSecret", clientId: s.clientId, token: undefined };
  const res = await dispatch("QueryShareInfo", { shareId: s.shareId, shareCode: s.shareCode }, opts);
  if (res?.RSP?.RSP_CODE !== "0000") {
    throw new Error(`查询分享信息失败: ${res?.RSP?.RSP_DESC || res?.RSP?.RSP_CODE || "未知"}${s.shareCode ? "" : "（可能需要提取码 --code）"}`);
  }
  return { ...s, info: res.RSP.DATA };
}

/** 分享内文件列表（匿名；ShareFileDetail 返回顶层条目） */
export async function shareFiles(input, code) {
  const s = await resolveShareLink(input, code);
  const opts = { secretType: "clientSecret", clientId: s.clientId, token: undefined };
  const res = await dispatch("ShareFileDetail", { shareId: s.shareId, shareCode: s.shareCode }, opts);
  if (res?.RSP?.RSP_CODE !== "0000") {
    throw new Error(`读取分享文件失败: ${res?.RSP?.RSP_DESC || res?.RSP?.RSP_CODE || "未知"}${s.shareCode ? "" : "（可能需要提取码 --code）"}`);
  }
  const files = Array.isArray(res.RSP.DATA) ? res.RSP.DATA : [];
  return {
    ...s,
    files: files.map((f) => ({
      fid: f.fid,
      id: f.id,
      name: f.fileName,
      size: Number(f.fileSize) || 0,
      type: String(f.type ?? (f.fileType === "0" ? "0" : f.fileType)),
      thumbUrl: f.thumbUrl || "",
      createTime: f.createTime || "",
      isDir: String(f.type) === "0" || String(f.fileType) === "0",
    })),
  };
}

/** 分享文件的下载直链（需要登录态：直链按账号签发） */
export async function shareDownloadUrl(fid, opts = {}) {
  const res = await dispatch("GetDownloadUrlV2", { type: "1", fidList: [fid] }, opts);
  const url = res?.RSP?.DATA?.list?.[0]?.downloadUrl;
  if (res?.RSP?.RSP_CODE !== "0000" || !url) {
    throw new Error(`取直链失败: ${res?.RSP?.RSP_DESC || res?.RSP?.RSP_CODE || "未知"}`);
  }
  return url;
}

/**
 * 纯逻辑：按偏好顺序尝试两条取链通道，前一条失败自动换另一条（可单测）。
 * @param {{v1:()=>Promise<{url:string}>, v2:()=>Promise<{url:string}>, prefer?:"v1"|"v2"}} p
 */
export async function tryDownloadApis({ v1, v2, prefer = "v1" }) {
  const order = prefer === "v2" ? [["V2", v2], ["V1", v1]] : [["V1", v1], ["V2", v2]];
  const errors = [];
  for (let i = 0; i < order.length; i++) {
    const [name, fn] = order[i];
    try {
      const r = await fn();
      if (!r?.url) throw new Error("无 downloadUrl");
      if (i > 0) r.note = `${errors[0].name} 失败（${errors[0].msg}）→ 已用 ${name}`;
      return { ...r, api: name.toLowerCase() };
    } catch (e) {
      errors.push({ name, msg: e?.message || String(e) });
    }
  }
  throw new Error(`取直链失败：${errors.map((e) => `${e.name} ${e.msg}`).join("；")}`);
}

/**
 * 取下载直链：V1（App 现行 `GetDownloadUrl`）优先，失败/空则回退 V2（`GetDownloadUrlV2`）。
 * 两者返回域名可能相同，V2 只在 V1 出问题时兜底；`opts.api = "v2"` 可反过来首选 V2。
 * @returns {Promise<{url:string, api:"v1"|"v2", note?:string}>}
 */
export async function getDownloadUrl(fid, opts = {}) {
  const spaceType = opts.spaceType || "0";
  const v1 = async () => {
    const res = await dispatch("GetDownloadUrl", { fidList: [fid], spaceType }, opts);
    return { url: res?.RSP?.DATA?.[0]?.downloadUrl, _desc: res?.RSP?.RSP_DESC || res?.RSP?.RSP_CODE };
  };
  const v2 = async () => {
    const res = await dispatch("GetDownloadUrlV2", { type: "1", fidList: [fid] }, opts);
    return { url: res?.RSP?.DATA?.list?.[0]?.downloadUrl, _desc: res?.RSP?.RSP_DESC || res?.RSP?.RSP_CODE };
  };
  const wrap = (fn) => async () => {
    const r = await fn();
    if (!r.url) throw new Error(r._desc || "无 downloadUrl");
    return { url: r.url };
  };
  return tryDownloadApis({ v1: wrap(v1), v2: wrap(v2), prefer: opts.api === "v2" ? "v2" : "v1" });
}

// 0=全部 1=图片 2=视频 3=音频 4=文档 5=其它
// 静态表仅作兜底；运行时优先用服务端 ClassifyRule（85 种扩展名，随服务端更新）
const TYPE_MAP = {
  "1": ["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tif", "tiff", "svg", "ico", "raw", "dng"],
  "2": ["mp4", "mov", "avi", "mkv", "flv", "wmv", "m4v", "mpg", "mpeg", "3gp", "ts", "rmvb", "webm", "mts"],
  "3": ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "ape", "opus", "aiff"],
  "4": ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf", "txt", "md", "csv", "rtf", "odt", "ods", "odp", "pages", "numbers", "key", "xmind"],
};

/** 静态兜底表（导出供 `types` 命令做差异对比） */
export const STATIC_TYPE_MAP = TYPE_MAP;

/** 服务端分类规则缓存：扩展名 → { type, subType } */
let _classifyMap = null;

/**
 * 拉取并缓存 ClassifyRule（服务端权威的「扩展名 → 文件类型」表）。
 * 失败不影响上传：getFileType 会退回静态表。
 */
export async function ensureClassifyRules(opts = {}) {
  if (_classifyMap) return _classifyMap;
  try {
    const res = await dispatch("ClassifyRule", {}, opts);
    const fileTypes = res?.RSP?.DATA?.fileTypes;
    if (fileTypes && typeof fileTypes === "object") {
      const map = new Map();
      for (const [rawExt, v] of Object.entries(fileTypes)) {
        const ext = String(rawExt).toLowerCase().trim();
        const type = String(v?.type ?? "");
        if (!ext || !/^[1-5]$/.test(type)) continue;   // 服务端有 type=7 / 空扩展名的脏数据，忽略
        map.set(ext, { type, subType: v.subType, ability: v.ability });
      }
      if (map.size) _classifyMap = map;
    }
  } catch {
    // 静默兜底
  }
  return _classifyMap;
}

export function getClassifyRules() {
  return _classifyMap;
}

export function getFileType(name) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  if (_classifyMap?.has(ext)) return _classifyMap.get(ext).type;
  for (const [t, exts] of Object.entries(TYPE_MAP)) {
    if (exts.includes(ext)) return t;
  }
  return "5";
}

/** 流式计算 SHA256（客户端用 64KB 块） */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path, { highWaterMark: 65536 });
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

function makeUniqueId() {
  const hex = [...Array(36)].map((_, i) =>
    [8, 13, 18, 23].includes(i) ? "-" : null);
  const rnd = () => Math.floor(Math.random() * 16);
  return hex.map((c, i) => {
    if (c === "-") return "-";
    if (i === 14) return "4";
    if (i === 19) return ((rnd() & 3) | 8).toString(16);
    return rnd().toString(16);
  }).join("");
}

function batchNo(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 秒传检查：POST quickTransfer，返回 {meta, result} */
export async function quickTransfer(token, info) {
  const res = await fetch(QUICK_TRANSFER_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "access-token": token,
    },
    body: JSON.stringify(info),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _httpStatus: res.status, _raw: text }; }
}

// ---- 断点续传：把「哪些分片已上传」持久化到本地 ----

const UPLOAD_STATE_DIR = join(homedir(), ".wocloud-cli", "uploads");

export function loadUploadState(sha256) {
  try {
    const p = join(UPLOAD_STATE_DIR, `${sha256}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

function saveUploadState(sha256, state) {
  try {
    mkdirSync(UPLOAD_STATE_DIR, { recursive: true });
    writeFileSync(join(UPLOAD_STATE_DIR, `${sha256}.json`), JSON.stringify(state));
  } catch { /* 状态文件写失败不影响上传 */ }
}

function clearUploadState(sha256) {
  try { unlinkSync(join(UPLOAD_STATE_DIR, `${sha256}.json`)); } catch { /* ignore */ }
}

/**
 * 区分可重试错误（结构化优先，消息正则兜底）
 *   1. err.retryable 显式标记最可信
 *   2. 业务码（"1000 请求参数错误" 这类 4 位码）是服务端明确答复，重试同请求不会变
 *   3. err.status / statusCode：5xx、408、429 可重试；其它 4xx 不重试
 *   4. 最后才看消息：只认「HTTP 4xx」这种明确语境，避免 "分片 4/400" 被误判
 */
export function isRetryable(err) {
  if (typeof err?.retryable === "boolean") return err.retryable;

  const msg = String(err?.message ?? err ?? "");
  const status = Number(err?.status ?? err?.statusCode) || 0;

  const biz = msg.match(/^(\d{4})\b/);
  if (biz) {
    if (/容量不足/.test(msg)) return false;
    // 参数错误 / token 失效 / 非法字符 / 容量不足 / 家庭空间参数错
    if (["1000", "1001", "1009", "2001", "9999"].includes(biz[1])) return false;
    return true;
  }

  if (status) return status >= 500 || status === 408 || status === 429;

  if (/容量不足/.test(msg)) return false;
  if (/\bHTTP\s*(400|401|403|404|413|422)\b/i.test(msg)) return false;
  return true;
}

/**
 * 上传单个分片（复刻客户端 createChunkFormData + uploadChunk）
 * multipart/form-data POST https://tjupload.pan.wo.cn/openapi/client/upload2C
 */
async function uploadChunk(token, opts, chunk, timeoutMs = 180_000) {
  const { uniqueId, fileName, fileSize, totalPart, partIndex, directoryId, spaceType, fileType, batch } = opts;
  const partLen = chunk.size ?? chunk.length;

  const fileInfo = {
    batchNo: batch,
    fileName,
    fileSize,
    fileType,
    directoryId,
    spaceType,
    deviceNo: "",
  };

  const form = new FormData();
  form.append("accessToken", token);
  form.append("uniqueId", uniqueId);
  form.append("fileName", fileName);
  form.append("fileSize", String(fileSize));
  form.append("totalPart", String(totalPart));
  form.append("partSize", String(partLen));
  form.append("partIndex", String(partIndex));   // 1-based
  form.append("channel", "wocloud");
  form.append("directoryId", directoryId);
  form.append("fileInfo", aesEncrypt(JSON.stringify(fileInfo), token));
  // Blob（openAsBlob 切片）直接挂上，undici 会按需从文件读；Buffer 则包一层
  form.append("file", chunk instanceof Blob ? chunk : new Blob([chunk]), fileName);

  const doPost = async (base) => {
    const res = await fetch(`${base}${UPLOAD_PATH}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return { _httpStatus: res.status, _raw: text.slice(0, 200), code: String(res.status), msg: `HTTP ${res.status}` };
    }
    if (res.status >= 500 || res.status === 404) {
      // 区域域名异常：交给上层决定是否回退
      data._httpStatus = res.status;
    }
    return data;
  };

  const base = getUploadServer();
  try {
    const data = await doPost(base);
    if ((data._httpStatus >= 500 || data._httpStatus === 404) && base !== UPLOAD_API) {
      _uploadServer = UPLOAD_API;          // 区域域名不可用 → 回退默认并重试一次
      return await doPost(UPLOAD_API);
    }
    return data;
  } catch (err) {
    if (base !== UPLOAD_API) {
      _uploadServer = UPLOAD_API;
      return await doPost(UPLOAD_API);
    }
    throw err;
  }
}

/** 简单信号量：限制全局同时在飞的请求数（多文件共享） */
export function makeSemaphore(limit) {
  let active = 0;
  const waiters = [];
  return async function run(fn) {
    if (active >= limit) await new Promise((r) => waiters.push(r));
    active++;
    try { return await fn(); }
    finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

/**
 * 云盘文件名预检（结论来自 rclone wopan 后端的真机 probe）
 *   - > 100 字符：服务端**静默截断**，会变成另一个文件 → 直接拒绝
 *   - 非 BMP 字符（如 😀 U+1F600）：服务端回裸 500
 *   - BMP emoji 象形符（© ® ™ ❤ …）：回 1009「名称中含有非法字符」，整个路径被拒
 * 后两类只警告不拦：emoji 表按 Unicode 分类生成，个别符号可能误伤，留给服务端裁决。
 * @returns {{error?:string, warning?:string}}
 */
export function checkRemoteName(leaf) {
  const chars = [...leaf];
  if (chars.length > 100) {
    return { error: `文件名 ${chars.length} 个字符，超过云盘 100 上限（服务端会静默截断，已拒绝上传）` };
  }
  const bad = chars.find((c) => c.codePointAt(0) > 0xFFFF || /\p{Extended_Pictographic}/u.test(c));
  if (bad) {
    const cp = bad.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    return { warning: `文件名含特殊符号“${bad}”(U+${cp})，云盘可能拒收（HTTP 500 / 1009），失败请改名重试` };
  }
  return {};
}

/**
 * 上传单个文件（秒传 → 分片并发 → 断点续传）
 * @returns {{ok:boolean, fid?:string, error?:string, warning?:string, skipped?:boolean, seconds?:number}}
 */
export async function uploadOneFile(localPath, dirId, opts, sem, onProgress) {
  const { token, spaceType = "0", concurrency, maxRetry, shouldAbort } = opts;
  const st = statSync(localPath);
  if (!st.isFile()) return { ok: false, error: "不是文件" };

  const fileName = basename(localPath);
  const nameCheck = checkRemoteName(fileName);
  if (nameCheck.error) return { ok: false, error: nameCheck.error };
  const fileSize = st.size;
  const fileType = getFileType(fileName);
  const batch = batchNo();
  const t0 = Date.now();

  const sha256 = await sha256File(localPath);
  const qt = await quickTransfer(token, {
    sha256, fileSize, fileName, fileType, batchNo: batch,
    spaceType, directoryId: dirId,
    fileModificationTime: Math.floor(st.mtimeMs),
  });
  if (qt?.meta?.code === "0000" && Number(qt?.result?.hasFile) === 1) {
    return { ok: true, skipped: true, seconds: (Date.now() - t0) / 1000 };
  }
  if (qt?.meta?.code === "2001") return { ok: false, error: "云盘容量不足" };

  const totalPart = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));

  // 断点续传
  const prev = loadUploadState(sha256);
  let uniqueId, doneSet;
  if (prev && prev.fileSize === fileSize && prev.fileName === fileName
      && prev.totalPart === totalPart && prev.uniqueId) {
    uniqueId = prev.uniqueId;
    doneSet = new Set(prev.uploadedChunks || []);
  } else {
    uniqueId = makeUniqueId();
    doneSet = new Set();
  }
  const state = {
    uniqueId, fileName, fileSize, totalPart,
    uploadedChunks: [...doneSet], updatedAt: Date.now(),
  };
  saveUploadState(sha256, state);

  // 优先 openAsBlob：Blob 由文件句柄支撑，slice 出来的分片不占内存；
  // 老 Node（<19.8）没有这个 API，退回 readSync 整块读。
  let fileBlob = null;
  try {
    const { openAsBlob } = await import("node:fs");
    fileBlob = await openAsBlob(localPath);
  } catch { /* 走下面的 readSync 分支 */ }
  const fd = fileBlob ? null : openSync(localPath, "r");
  let doneCount = doneSet.size, resultFid = "", postedAny = false;
  let firstError = null;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (firstError) return;
      if (shouldAbort?.()) { firstError = new Error("已被取消（cancelled）"); return; }
      const i = cursor++;
      if (i >= totalPart) return;
      if (doneSet.has(i)) { onProgress?.(doneCount, totalPart); continue; }

      const start = i * CHUNK_SIZE;
      const size = Math.min(CHUNK_SIZE, fileSize - start);
      let buf;
      if (fileBlob) {
        buf = fileBlob.slice(start, start + size);      // 零拷贝：只记 [start, end)
      } else {
        buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, start);
      }

      let attempt = 0, ok = false, lastErr = "";
      while (attempt < maxRetry && !ok) {
        attempt++;
        try {
          const r = await sem(() => uploadChunk(token, {
            uniqueId, fileName, fileSize, totalPart,
            partIndex: i + 1, directoryId: dirId, spaceType, fileType, batch,
          }, buf));
          if (r?.code === "0000") {
            ok = true;
            postedAny = true;
            if (r?.data?.fid) resultFid = r.data.fid;
            break;
          }
          lastErr = `${r?.code} ${r?.msg ?? ""}`;
          if (!isRetryable(lastErr)) break;
        } catch (e) {
          lastErr = e?.name === "TimeoutError" ? "请求超时" : (e?.message || String(e));
          if (!isRetryable(e)) break;
        }
        if (attempt < maxRetry) {
          await new Promise((r) => setTimeout(r, 3000 * Math.pow(2, attempt - 1)));
        }
      }
      if (!ok) { firstError = new Error(`分片 ${i + 1}/${totalPart} 失败: ${lastErr}`); return; }

      doneSet.add(i);
      state.uploadedChunks = [...doneSet];
      state.updatedAt = Date.now();
      saveUploadState(sha256, state);
      doneCount++;
      onProgress?.(doneCount, totalPart);
    }
  };

  try {
    const workers = Math.max(1, Math.min(concurrency, totalPart));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (firstError) throw firstError;
    if (postedAny && !resultFid) {
      throw new Error("上传完成但服务端未返回 fid（疑似空对象），请用 ls 复核后再重试");
    }
    clearUploadState(sha256);
    return {
      ok: true, fid: resultFid, seconds: (Date.now() - t0) / 1000,
      warning: nameCheck.warning,
    };
  } catch (e) {
    return { ok: false, error: e.message, seconds: (Date.now() - t0) / 1000 };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** 跳过客户端也会忽略的系统/临时文件 */
export function shouldSkipLocal(name) {
  if (/^(\.DS_Store|\.Spotlight-V100|\.Trashes|\.fseventsd|\.VolumeIcon\.icns|desktop\.ini|Thumbs\.db)$/i.test(name)) {
    return true;
  }
  if (/^\._/.test(name)) return true;        // macOS AppleDouble 伴生文件
  if (/~\$/.test(name)) return true;         // Office 临时文件
  return false;
}

/** 递归扫描本地目录，返回 [{abs, rel}] */
export function scanLocal(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (shouldSkipLocal(e.name)) continue;
      const abs = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ abs, rel: r });
    }
  };
  walk(dir, "");
  return out;
}

/**
 * 并发上传一批文件
 *
 * @param {Array<{path:string, dirId:string}>} items
 * @param {object} opts { token, spaceType, chunkConc, fileConc, maxRetry, sem,
 *                        onProgress?(fileName, done, total), onLog?(line), shouldAbort?() }
 * @returns {Promise<{okCount,skipCount,failCount,seconds,results:Array}>}
 */
export async function uploadItems(items, opts) {
  const {
    token, spaceType = "0", chunkConc, fileConc, maxRetry, sem,
    onProgress, onLog, shouldAbort,
  } = opts;

  // 首次上传前解析账号所属上传区域（失败自动回退 tjupload）
  const zoneHost = await resolveUploadServer(opts);
  onLog?.(`上传区域: ${zoneHost}`);

  // 服务端分类规则（扩展名 → 文件类型），取不到就退回内置静态表
  const rules = await ensureClassifyRules(opts);
  if (rules) onLog?.(`文件类型规则: ${rules.size} 种（服务端 ClassifyRule）`);

  const sized = items.map((it) => ({ ...it, size: statSync(it.path).size }));
  sized.sort((a, b) => a.size - b.size);          // 小文件优先
  const totalBytes = sized.reduce((acc, it) => acc + it.size, 0);
  onLog?.(`准备上传 ${sized.length} 个文件 (共 ${fmtSize(totalBytes)})，分片并发 ${chunkConc} · 文件并发 ${fileConc}`);

  let okCount = 0, skipCount = 0, failCount = 0, doneFiles = 0;
  const results = [];
  const t0 = Date.now();
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (shouldAbort?.()) return;
      const idx = cursor++;
      if (idx >= sized.length) return;
      const it = sized[idx];
      const name = basename(it.path);

      const r = await uploadOneFile(it.path, it.dirId, {
        token, spaceType, concurrency: chunkConc, maxRetry, shouldAbort,
      }, sem, (done, total) => onProgress?.(name, done, total));

      doneFiles++;
      const tag = `[${doneFiles}/${sized.length}]`;
      if (r.ok && r.skipped) {
        skipCount++;
        onLog?.(`${tag} ${name} → 秒传命中，跳过`);
      } else if (r.ok) {
        okCount++;
        const mbps = (it.size / 1048576 / Math.max(r.seconds, 0.01)).toFixed(1);
        onLog?.(`${tag} ${name} 上传成功，${r.seconds.toFixed(1)}s，${mbps} MB/s`);
        if (r.warning) onLog?.(`   ⚠️ ${r.warning}`);
      } else {
        failCount++;
        onLog?.(`${tag} ${name} 失败: ${r.error}`);
      }
      results.push({
        path: it.path, dirId: it.dirId,
        ok: r.ok, skipped: !!r.skipped, error: r.error,
        seconds: r.seconds, fid: r.fid, warning: r.warning,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(fileConc, sized.length) }, () => worker()));

  const sec = (Date.now() - t0) / 1000;
  const mbps = (totalBytes / 1048576 / Math.max(sec, 0.01)).toFixed(1);
  onLog?.(`完成: 上传 ${okCount} · 秒传 ${skipCount} · 失败 ${failCount} · 耗时 ${sec.toFixed(1)}s (${mbps} MB/s)`);
  return { okCount, skipCount, failCount, seconds: sec, totalBytes, results };
}

// ---------------------------------------------------------------- 下载（流式）

/**
 * 流式下载 URL 到本地文件（不落内存，5GB 大文件也不会 OOM）
 * @returns {Promise<{bytes:number}>}
 */
export async function downloadToFile(url, outPath, opts = {}) {
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
  });
  if (!res.ok || !res.body) {
    const e = new Error(`HTTP ${res.status}${res.body ? "" : "（空响应体）"}`);
    e.status = res.status;
    throw e;
  }
  await pipeline(res.body, createWriteStream(outPath));
  return { bytes: Number(res.headers.get("content-length")) || 0 };
}

// 直链有效期与失效语义（rclone wopan 后端 2026-09-30 实测，MIT）：
//   · 直链签发后 120 分钟到期，且不随访问滑动
//   · CDN 用 519 表示链接自然过期，518 表示 URL 被篡改/拼错，403 表示被撤销或无权限
//   · 这三个状态重试同一个 URL 永远不会成功 —— 必须重新签发直链再从断点续传
// 若下载期间链接失效（大文件 / 长时间 mirror 必然遇到），旧逻辑会把它当成
// 不可重试错误直接失败，或让 --retry 反复重试同一个死链。
const LINK_EXPIRED_STATUS = new Set([403, 518, 519]);

// 直链真实寿命 120 分钟且不随访问滑动（rclone 实测）。长任务不等到过期再救，
// 用到 25 分钟就主动换一条：换链成本一次 API 调用，撞过期则要中断并回退该段进度。
const LINK_TTL_MS = 25 * 60 * 1000;

// ---------------------------------------------------------------- 下载（分段并行）
// 2026-10-25 实测：tjdownload 单连接被限速 ~0.15MB/s（不同文件一致），Range 请求
// 返回 206 / accept-ranges: bytes，并发段数与吞吐线性相关（6 段 5.5×、16 段 10× 未触顶）。
// 服务端行为与官方客户端多线程下载一致 —— 分段并行是绕开限速的正解。

/**
 * 分段并行下载：Range 探测 → 并发段写入预分配文件的各自偏移 → 逐段重试 → 总大小校验。
 * 服务器不支持 Range 或文件过小时自动退化为单流 downloadToFile。
 *
 * 直链过期（403/518/519）时，若调用方提供 refreshUrl，则单飞刷新直链后从断点续传；
 * 刷新次数上限 maxLinkRefresh，刷新本身失败仍按普通错误处理。
 *
 * @param {string} url 首次下载直链
 * @param {object} [opts]
 * @param {() => Promise<string>} [opts.refreshUrl] 重新签发直链的回调（返回新 URL）
 * @returns {Promise<{bytes:number, segments:number, fallback?:boolean, linkRefreshes?:number}>}
 */
export async function downloadSegmented(url, outPath, opts = {}) {
  const {
    segments = 32,                    // 并发分段数（实测：16 段 11×、32 段 16×、64 段仅 +5% → 32 为甜点）
    minSegSize = 1024 * 1024,         // 每段最小体积：文件太小自动降段（1MB，让小文件也能并行）
    timeoutMs = 300_000,
    maxRetry = 3,
    onProgress,                       // (doneBytes, totalBytes)
    shouldAbort,
    refreshUrl,                       // 直链过期时重新签发的回调
    maxLinkRefresh = 5,               // 一次下载最多换几次链接
    linkTtlMs = LINK_TTL_MS,          // 主动换链间隔（测试可调小）
  } = opts;

  let currentUrl = url;
  let linkRefreshes = 0;
  let linkIssuedAt = Date.now();
  let refreshing = null;              // 单飞：32 段同时过期时只刷新一次

  // 主动换链：到点就换，不等 CDN 回 519。并发段同时到点时由 refreshLink 单飞合并。
  const ensureFreshLink = async () => {
    if (!refreshUrl) return;
    if (Date.now() - linkIssuedAt < linkTtlMs) return;
    await refreshLink();
  };

  // 返回 true 表示链接已刷新，可以重试
  const refreshLink = async () => {
    if (!refreshUrl || linkRefreshes >= maxLinkRefresh) return false;
    if (refreshing) return refreshing;
    linkRefreshes++;
    refreshing = (async () => {
      try {
        const next = await refreshUrl();
        if (!next) return false;
        currentUrl = next;
        linkIssuedAt = Date.now();
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  // 1) 探测：Range 0-0 → 206 则支持分段并拿到总大小（content-range: bytes 0-0/3648）
  //    直链可能在探测阶段就已过期（mirror 排队久了、或 CLI 从别处拿到旧链接）
  //    CDN 对突发请求会误报 404（实测连打 10 次 Range 只有 1 次 206），这类 404 是瞬时的
  let probe;
  for (let i = 0; ; i++) {
    probe = await fetch(currentUrl, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (LINK_EXPIRED_STATUS.has(probe.status) && (await refreshLink())) continue;
    if (probe.status === 404 && i < 2) {
      try { await probe.arrayBuffer(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      continue;
    }
    break;
  }
  let total = 0, ranged = false;
  if (probe.status === 206) {
    const m = (probe.headers.get("content-range") || "").match(/\/(\d+)$/);
    if (m) { total = Number(m[1]); ranged = true; }
  } else if (probe.status === 200) {
    total = Number(probe.headers.get("content-length")) || 0;
  } else {
    throw new Error(`HTTP ${probe.status}（下载探测失败${LINK_EXPIRED_STATUS.has(probe.status) ? "：直链已失效" : ""}）`);
  }
  try { await probe.arrayBuffer(); } catch { /* 探测响应体已无关紧要 */ }

  if (!ranged || !total) {
    const r = await downloadToFile(currentUrl, outPath, { timeoutMs });
    onProgress?.(r.bytes, r.bytes);
    return { bytes: r.bytes, segments: 1, fallback: true, linkRefreshes };
  }

  // 2) 分段
  const n = Math.max(1, Math.min(segments, Math.ceil(total / minSegSize)));
  const segSize = Math.ceil(total / n);
  const tasks = Array.from({ length: n }, (_, i) => ({
    idx: i,
    start: i * segSize,
    end: Math.min(total, (i + 1) * segSize) - 1,
  }));

  const fd = openSync(outPath, "w");
  try {
    ftruncateSync(fd, total);
    let doneBytes = 0, firstError = null, cursor = 0;

    const worker = async () => {
      for (;;) {
        if (firstError) return;
        if (shouldAbort?.()) { firstError = new Error("已取消"); return; }
        const i = cursor++;
        if (i >= tasks.length) return;
        const t = tasks[i];
        let attempt = 0;
        for (;;) {
          attempt++;
          let received = 0;
          try {
            await ensureFreshLink();
            const attemptUrl = currentUrl;
            const res = await fetch(attemptUrl, {
              headers: { Range: `bytes=${t.start}-${t.end}` },
              signal: AbortSignal.timeout(timeoutMs),
            });
            // 直链过期：换链后从该段起点重新拉，不计入失败次数
            if (LINK_EXPIRED_STATUS.has(res.status)) {
              try { await res.arrayBuffer(); } catch { /* ignore */ }
              // 并发段可能同时撞上旧链接：只要别的段已经换过链，直接用新链接重试，
              // 不再重复消耗换链额度（否则一次过期会被吃满 maxLinkRefresh）
              if (attemptUrl !== currentUrl) { attempt--; continue; }
              if (await refreshLink()) { attempt--; continue; }
              throw new Error(`HTTP ${res.status}（直链失效且无法刷新）`);
            }
            if (!res.ok || !res.body) {
              const e = new Error(`HTTP ${res.status}`);
              e.status = res.status;
              throw e;
            }
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              writeSync(fd, value, 0, value.length, t.start + received);
              received += value.length;
              doneBytes += value.length;
              onProgress?.(Math.min(doneBytes, total), total);
            }
            if (received !== t.end - t.start + 1) {
              throw new Error(`段 ${t.idx} 不完整（${received}/${t.end - t.start + 1}）`);
            }
            break;
          } catch (e) {
            doneBytes -= received;   // 该段作废，进度回退，重试后重算
            // CDN 反滥用会把突发请求打成 404，这类 404 与"文件不存在"无关，应重试
            const transient404 = /HTTP 404/.test(String(e?.message || e));
            if (attempt >= maxRetry || (!isRetryable(e) && !transient404)) {
              firstError = new Error(`段 ${t.idx} 下载失败: ${e?.message || e}`);
              return;
            }
            // 指数退避 + 抖动，避免 32 段同时重试探头一致再次被打
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5)));
          }
        }
      }
    };

    await Promise.all(Array.from({ length: n }, () => worker()));

    if (firstError) throw firstError;
    if (statSync(outPath).size !== total) {
      throw new Error(`下载不完整（${statSync(outPath).size}/${total}）`);
    }
    return { bytes: total, segments: n, linkRefreshes };
  } catch (e) {
    // 失败不留半截文件
    try { unlinkSync(outPath); } catch { /* ignore */ }
    throw e;
  } finally {
    closeSync(fd);
  }
}

/** 按目录并发跑任务（简单池） */
export async function runPool(items, limit, fn) {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
}

// ---------------------------------------------------------------- 版本网关（fileVersionDispatcher）
// 抓包实证（2026-10-14）：/wohome/fileVersionDispatcher 是网关，
// header.uri 才是真实路径（/cloud/file-version/*），明文 JSON，响应 {meta, result}

export async function callVersionGateway(uri, params, opts = {}) {
  const token = opts.token;
  return postApi("/wohome/fileVersionDispatcher", {
    header: { uri, accessToken: token },
    body: params,
  }, opts);
}

/** 本机 deviceNo（批量重命名等写操作需要；抓包实证值，可由调用方覆盖） */
export const DEFAULT_DEVICE_NO = "432ea42a-43a3-5350-8c6b-c7e5b027966e";
