#!/usr/bin/env node
/**
 * token-keeper —— 服务器端唯一的 token 续期者
 *
 * 为什么必须集中：exchange 续期会**立刻作废旧 token**（2026-10-26 实测 3/3）。
 * 多台设备各自续期会互踢；所以由本进程独占续期权，设备只从 relay 取最新 token。
 *
 * 行为：
 *   - 每 TOKEN_REFRESH_MINUTES（默认 30）检查一次，token 年龄不足 80% 就跳过，避免 PM2 重启造成抖动
 *   - 先走 exchange（只要 accessToken 有效即可），失败再走 refreshToken 兜底
 *   - 成功后原子写回 relay 凭证文件（0600）；失败 5 分钟后重试，日志留在 PM2
 *
 * 环境变量：
 *   RELAY_FILE               凭证文件（与 relay-server 一致）
 *   TOKEN_REFRESH_MINUTES    正常刷新周期（默认 30）
 *   TOKEN_REFRESH_RETRY_MIN  失败重试间隔（默认 5）
 *   TOKEN_REFRESH_START_SEC  启动后首次检查延迟（默认 5）
 */
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";

// 服务器上 core 与本文件同目录；仓库里 core 在上一级 —— 两处都能跑
let refreshToken, refreshByRefreshToken;
try {
  ({ refreshToken, refreshByRefreshToken } = await import("./wocloud-core.mjs"));
} catch {
  ({ refreshToken, refreshByRefreshToken } = await import("../wocloud-core.mjs"));
}

const FILE = process.env.RELAY_FILE || "/opt/wocloud-relay/relay-creds.json";
const MIN = Number(process.env.TOKEN_REFRESH_MINUTES || 30);
const RETRY_MIN = Number(process.env.TOKEN_REFRESH_RETRY_MIN || 5);
const START_SEC = Number(process.env.TOKEN_REFRESH_START_SEC || 5);
const INTERVAL = MIN * 60_000;

function log(...a) {
  console.log(`[token-keeper] ${new Date().toISOString()}`, ...a);
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

let timer = null;
function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, ms);
}

async function run() {
  let nextDelay = INTERVAL;
  const st = readStore();
  if (!st) {
    log("没有凭证，跳过（先 token --push 或手工写入）");
    schedule(nextDelay);
    return;
  }
  const ageMs = Date.now() - (Number(st.savedAt) || 0);
  if (ageMs < INTERVAL * 0.8) {
    log(`token 还年轻（${Math.round(ageMs / 60_000)} 分钟），跳过`);
    schedule(nextDelay);
    return;
  }

  const t0 = Date.now();
  let via = "exchange";
  let next = null;
  let rt = st.refreshToken || null;
  try {
    next = await refreshToken(st.accessToken);
  } catch (e) {
    log("exchange 异常:", e?.message || e);
  }
  if (!next && rt) {
    via = "refreshToken";
    try {
      const r = await refreshByRefreshToken(rt);
      next = r?.accessToken || null;
      if (r?.refreshToken) rt = r.refreshToken;
    } catch (e) {
      log("refreshToken 异常:", e?.message || e);
    }
  }

  if (!next) {
    log(`续期失败（exchange${rt ? " + refreshToken" : ""} 都没拿到新 token），${RETRY_MIN} 分钟后重试`);
    schedule(RETRY_MIN * 60_000);
    return;
  }

  writeStore({
    accessToken: next,
    refreshToken: rt,
    savedAt: Date.now(),
    refreshedAt: Date.now(),
    via,
  });
  log(`续期成功（${via}，${Date.now() - t0}ms），下次 ${MIN} 分钟后`);
  schedule(nextDelay);
}

log(`启动：周期 ${MIN} 分钟，失败重试 ${RETRY_MIN} 分钟，文件 ${FILE}`);
schedule(START_SEC * 1000);
