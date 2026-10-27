#!/usr/bin/env node
/**
 * wocloud-relay —— 凭证中转 + token 保活（服务端明文持有，供 token-keeper 续期）
 *
 * 与旧版（端到端加密 blob）的区别：
 *   - 存储改为明文 `{accessToken, refreshToken, savedAt, refreshedAt, via}`（0600）
 *   - 因为「服务器保活」必须能拿 accessToken 去 exchange，密文解不开就无法续期
 *   - 安全边界：X-Relay-Key 鉴权 + 文件 0600 + 只监听内网（Nginx TLS 反代到公网）
 *
 * 端点：
 *   GET  /credentials   → 200 {accessToken, savedAt, refreshedAt, via}（不返回 refreshToken）
 *   POST /credentials   → 写入 {accessToken, refreshToken?, savedAt?}
 *   GET  /health        → {ok, savedAt, ageSeconds}（无需明细，便于探活）
 *
 * 续期由 `token-keeper.mjs` 负责（独立 PM2 进程），本进程只管存取。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const KEY = process.env.RELAY_KEY;
if (!KEY) {
  console.error("[wocloud-relay] 必须设置 RELAY_KEY 环境变量（与 CLI --key 一致）");
  process.exit(1);
}
const HOST = process.env.RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT || 8787);
const FILE = process.env.RELAY_FILE || "/opt/wocloud-relay/relay-creds.json";
const MAX_BODY = 8 * 1024;

const keyBuf = Buffer.from(KEY);
function keyOk(got) {
  const a = Buffer.from(String(got || ""));
  return a.length === keyBuf.length && timingSafeEqual(a, keyBuf);
}

function fail(res, code, msg) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}

function readStore() {
  if (!existsSync(FILE)) return null;
  try {
    const j = JSON.parse(readFileSync(FILE, "utf8"));
    return typeof j?.accessToken === "string" && j.accessToken.length >= 8 ? j : null;
  } catch {
    return null;
  }
}

function writeStore(obj) {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const st = readStore();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      hasToken: !!st,
      savedAt: st?.savedAt || null,
      ageSeconds: st?.savedAt ? Math.round((Date.now() - st.savedAt) / 1000) : null,
      via: st?.via || null,
    }));
    return;
  }

  // 新版 CLI 发 X-Relay-Key；保留 X-Hub-Key 兼容旧脚本
  const gotKey = req.headers["x-relay-key"] || req.headers["x-hub-key"];
  if (!keyOk(gotKey)) return fail(res, 403, "key 不对");

  if (req.method === "GET" && req.url === "/credentials") {
    const st = readStore();
    if (!st) return fail(res, 404, "还没有凭证");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      accessToken: st.accessToken,
      savedAt: st.savedAt || null,
      refreshedAt: st.refreshedAt || null,
      via: st.via || "push",
    }));
    return;
  }

  if (req.method === "POST" && req.url === "/credentials") {
    let body = "", over = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) { over = true; req.destroy(); }
    });
    req.on("end", () => {
      if (over) return;
      try {
        const j = JSON.parse(body);
        if (j?.iv || j?.tag || j?.data) throw new Error("legacy-encrypted");
        if (typeof j?.accessToken !== "string" || j.accessToken.length < 8) throw new Error("bad-token");
        const rec = {
          accessToken: j.accessToken,
          refreshToken: typeof j.refreshToken === "string" && j.refreshToken ? j.refreshToken : null,
          savedAt: Number(j.savedAt) || Date.now(),
          refreshedAt: null,
          via: "push",
        };
        writeStore(rec);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, savedAt: rec.savedAt }));
      } catch (e) {
        fail(res, 400, e?.message === "legacy-encrypted" ? "旧版加密格式，请升级 CLI（新版存明文供保活）" : "body 不是合法的凭证 JSON");
      }
    });
    return;
  }

  fail(res, 404, "not found");
}).listen(PORT, HOST, () => {
  console.log(`[wocloud-relay] ${HOST}:${PORT} 就绪（明文存储，key 指纹已校验）`);
  console.log(`[wocloud-relay] 存储: ${FILE}（0600，仅本机 root 可读）`);
});
