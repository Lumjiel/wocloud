#!/usr/bin/env node
/**
 * wocloud.mjs — 联通云盘第三方 CLI（瘦壳）
 *
 * 协议、加密、上传下载、token 管理全在 ./wocloud-core.mjs（唯一真源），
 * 本文件只做参数解析与输出格式化，跨设备（Mac / Windows / Termux）跑同一份。
 *
 * 基于对「联通云盘」客户端 v2.8.13 的静态逆向，仅用于个人账号的互操作性访问，
 * 请自行确认符合服务条款。
 */

import { existsSync, statSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import {
  BASE_API, APP_VERSION, SECRETS, CLIENT_IDS, CREDS_DIR, CREDS_FILE,
  DEFAULT_CONCURRENCY, DEFAULT_FILE_CONCURRENCY, GLOBAL_MAX_INFLIGHT, MAX_RETRY,
  DEFAULT_DEVICE_NO, callVersionGateway,
  dispatch, postApi, fmtSize, makeSemaphore, scanLocal,
  uploadItems, downloadToFile, downloadSegmented, runPool,
  resolveSession, loadCredentials, saveCredentials,
  refreshSession, maskToken, qrGenerate, qrQuery, readClientTokens,
  loadRelayConfig, saveRelayConfig, pullRelayToken,
  querySysConfig, ensureClassifyRules, STATIC_TYPE_MAP,
  shareInfo, shareFiles, shareDownloadUrl, getDownloadUrl,
} from "./wocloud-core.mjs";

// ---------------------------------------------------------------- 参数与输出

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const nxt = argv[i + 1];
        if (nxt !== undefined && !nxt.startsWith("--")) { out[a.slice(2)] = nxt; i++; }
        else out[a.slice(2)] = true;
      }
    } else out._.push(a);
  }
  return out;
}

function printResult(data) {
  if (data?.RSP) {
    const { RSP_CODE, RSP_DESC } = data.RSP;
    if (RSP_CODE && RSP_CODE !== "0000") {
      console.error(`✗ 接口错误 ${RSP_CODE}: ${RSP_DESC || "未知错误"}`);
    }
  }
  console.log(JSON.stringify(data, null, 2));
}

/** 清理文件名中的非法字符，避免写出越界路径 */
function safeName(name) {
  return String(name)
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 200);
}

const TOKEN_SOURCE_LABEL = {
  arg: "命令行 --token",
  env: "环境变量 WOCLOUD_TOKEN",
  client: "本机客户端 leveldb",
  file: "~/.wocloud/credentials.json",
};

function printTokenInfo(s) {
  console.log(`来源:     ${TOKEN_SOURCE_LABEL[s.source] || s.source}`);
  console.log(`accessToken: ${maskToken(s.accessToken)}`);
  console.log(`refreshToken: ${s.refreshToken ? maskToken(s.refreshToken) : "(无)"}`);
  if (s.savedAt) console.log(`保存于:   ${new Date(s.savedAt).toLocaleString()}`);
}

const HELP = `
联通云盘 CLI (wocloud) — 基于客户端逆向的私有 API 封装（跨设备版）

用法: node wocloud.mjs <命令> [参数]

命令:
  login [--image]            扫码登录：出二维码 → 手机「联通云盘」App 扫一扫确认
                             --image 用图片文件代替终端渲染（自动保存 login-qr.png）
  doctor                     健康检查：凭证/鉴权/续期链路/容量
  whoami                     查询当前登录用户信息
  usage                      查询容量使用情况
  limits                     账号限制：单目录文件数上限 / 回收站天数 / 单次选择上限
  types                      服务端文件类型规则（扩展名 → 类型），并对比内置表
  share-info <链接>          他人分享：查看分享者/有效期（--code 提取码）
  share-ls <链接>            他人分享：列出文件（--code 提取码）
  share-dl <链接> [序号|名]  他人分享：取直链或下载（--out 落盘，--segments 分段）
  ls [--dir <id>]            列出目录内容 (默认根目录 0)
  tree [--dir <id>] [--depth <n>] [--json]   递归盘点目录树与占用
  find <关键字>              搜索文件（返回含 fid 字段，供 download 使用）
  by-type <1-5> [--dir <id>] 按类型浏览：1=图 2=视频 3=音频 4=文档 5=其它（默认全盘）
  path [--dir <id>]          目录 id → 可读路径（面包屑）
  versions <文件id>          文件历史版本列表
  download <fid> [--out <路径>] [--segments 32] [--api v1|v2]   获取直链/下载（V1 优先退 V2，25 分钟自动换链）
  upload <本地文件...> [--dir <id>] [--concurrency <n>] [--files <n>] [--retry <n>] [--no-verify]
                             上传文件，支持多文件并发（秒传 + 16MB 分片 + 断点续传 + 事后大小校验）
  push <本地目录> --to <云盘目录id> [--concurrency <n>] [--files <n>] [--no-verify]
                             递归上传整个目录，自动在云端建出相同结构
  mirror <云盘目录id> <本地路径> [--dry-run] [--files 3] [--segments 32]
                             云盘目录镜像到本地（增量 + 多文件并发 + 单文件分段并行 + 大小校验）
  cp <id...> --to <目录id> [--dir]           复制文件/目录（非破坏性）
  mkdir <名称> [--dir <id>]  新建目录
  rename <id> <新名字> [--dir] [--version <n>] [--yes]   重命名文件/目录
  batch-rename <id...> --parent <目录id> [--types 1,0] [--prefix] [--suffix] [--index] [--yes]
                             批量重命名（异步任务；默认预演）
  rm <id...> [--dir] [--recursive] [--version <n>] [--yes]  删除文件/目录（默认只预演，--yes 才真删）
  mv <id...> --to <目录id> [--dir] [--version <n>] [--yes]   移动文件/目录（默认只预演）
  fav <文件id...> [--dir-ids <id,id>] [--cancel]   收藏/取消收藏
  fav-list [--page 0] [--limit 50] [--json]  收藏列表
  share <文件id...> [--dirs <id,id>] [--days 7] [--no-auto-fill]   创建分享链接
  share-list [--page 1] [--limit 20] [--json]  我的分享列表
  unshare <shareId...> [--delete]   取消分享（--delete 连记录删除）
  trash [--limit <n>] [--json] [--soon-days <n>]   查看回收站（标记即将到期）
  restore <deleteNo...> [--yes]  从回收站还原
  purge <deleteNo...> [--yes] [--soon-days <n>]    彻底删除（清空前统计到期）
  empty-trash [--yes] [--soon-days <n>]           清空回收站（清空前统计到期）
  token                        查看 token 来源与状态
  token --save                 保存当前会话到 ~/.wocloud/credentials.json（跨设备复制用）
  token --refresh              强制刷新 token 并落盘
  token --export               打印 credentials.json 内容（复制到其他设备）
  token --push --relay <url> --key <口令>    把凭证推到自建 relay（服务器从此负责续期保活）
  token --pull --relay <url> --key <口令>    从 relay 拉取最新凭证并自检（配一次后参数可省）
                             relay 由服务器保活；部署与安全边界见 relay/README.md（明文 0600）
  post <路径> [jsonBody]       直接 POST 到 panservice（调试用）
  raw <key> [jsonBody]         直接调用任意 dispatcher 接口（调试用）

token 解析链（三端一致）:
  --token 参数 → WOCLOUD_TOKEN 环境变量
  → ~/.wocloud/credentials.json（login / token --save 产出，跨设备可复制）
  → 本机客户端 leveldb（桌面端装了客户端的免配置甜点）
  token 失效（业务码 1001）时自动刷新并持久化；刷新也失败时回退试客户端 leveldb。

全局参数:
  --token <token>            指定 accessToken
  --client-id <id>           clientId（默认 1001000210）
  --secret <key>             secretKey（默认 mac 平台内置值）
  --space <n>                空间类型，0=个人（默认）
  --device <no>              设备号（部分写操作需要）

⚠️  破坏性操作（rm / mv）默认只预演，必须显式加 --yes 才会真正执行。

环境变量:
  WOCLOUD_TOKEN              等价于 --token

示例:
  node wocloud.mjs ls
  node wocloud.mjs find 报告
  node wocloud.mjs download "<fid>" --out ./report.docx
`;

// ---------------------------------------------------------------- 扫码登录：PNG 解码与终端渲染

/** 极简 PNG 解码（位深 8，色彩类型 0/2/3/4/6），返回 {w,h,dark:Uint8Array} */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, palette = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!(bitDepth === 8 || (bitDepth === 1 && colorType === 0))) {
    throw new Error(`不支持的位深/色彩类型: ${bitDepth}/${colorType}`);
  }
  const channels = bitDepth === 1 ? 1 : { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 1 && !channels) throw new Error(`不支持的色彩类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  // 1-bit 灰度按字节打包；其余按通道×字节
  const stride = bitDepth === 1 ? Math.ceil(w / 8) : w * channels;
  const bppBytes = bitDepth === 1 ? 1 : channels;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rawv = raw[p + x];
      const left = x >= bppBytes ? out[y * stride + x - bppBytes] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = y > 0 && x >= bppBytes ? out[(y - 1) * stride + x - bppBytes] : 0;
      let v;
      if (filter === 0) v = rawv;
      else if (filter === 1) v = rawv + left;
      else if (filter === 2) v = rawv + up;
      else if (filter === 3) v = rawv + ((left + up) >> 1);
      else {
        const a = left, b = up, c = ul;
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = rawv + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + x] = v & 0xff;
    }
    p += stride;
  }
  const dark = new Uint8Array(w * h);
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d = 0;
      if (bitDepth === 1) {
        // 1-bit 灰度：MSB 在前，0=黑 1=白
        d = (out[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 1;
      } else {
        const i = y * stride + x * channels;
        if (colorType === 0) d = out[i] < 128 ? 1 : 0;
        else if (colorType === 2) d = lum(out[i], out[i + 1], out[i + 2]) < 128 ? 1 : 0;
        else if (colorType === 3) {
          const pi = out[i] * 3;
          d = palette && lum(palette[pi], palette[pi + 1], palette[pi + 2]) < 128 ? 1 : 0;
        } else if (colorType === 4) d = out[i + 1] >= 128 && out[i] < 128 ? 1 : 0;
        else d = out[i + 3] >= 128 && lum(out[i], out[i + 1], out[i + 2]) < 128 ? 1 : 0;
      }
      dark[y * w + x] = d;
    }
  }
  return { w, h, dark };
}

/** 从像素图提取模块矩阵：
 *  1) 暗像素包围盒定位 QR 主体（四周是白 quiet zone）
 *  2) 顶部第一段黑色连续条 = finder 上边 = 7 模块宽 → 推算模块边长 pitch
 *  3) 按模块中心采样，避免非整数 px/模块的累积漂移
 */
function qrModules(png) {
  const { w, h, dark } = png;
  // 包围盒
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (dark[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("QR 图像里没有暗像素");
  // 顶部 finder 上边：y0 行从 x0 起的第一段连续黑
  let run = 0;
  while (x0 + run <= x1 && dark[y0 * w + x0 + run]) run++;
  const pitch = run / 7;                      // finder 边框恰好 7 模块
  if (pitch < 1) throw new Error("QR 模块尺寸异常");
  const n = Math.round((x1 - x0 + 1) / pitch);
  if (n < 21 || n > 177 || (n - 1) % 4 !== 0) {
    throw new Error(`QR 模块数异常: ${n}`);
  }
  const grid = [];
  for (let my = 0; my < n; my++) {
    const row = [];
    for (let mx = 0; mx < n; mx++) {
      const px = Math.floor(x0 + (mx + 0.5) * pitch);
      const py = Math.floor(y0 + (my + 0.5) * pitch);
      row.push(dark[py * w + px] ? 1 : 0);
    }
    grid.push(row);
  }
  return grid;
}

/** 模块矩阵 → ANSI 背景色方块（黑模块/白底色，主题无关，2 空格 ≈ 正方形） */
function renderQr(grid) {
  return grid.map((row) =>
    row.map((d) => (d ? "\x1b[40m  \x1b[0m" : "\x1b[47m  \x1b[0m")).join(""),
  ).join("\n");
}

/** 上传事后校验：按目标目录查一次云端列表，比对每个已上传文件的大小 */
async function verifyUploads(results, opts, spaceType) {
  const byDir = new Map();
  for (const r of results) {
    if (!r.ok || r.skipped) continue;
    if (!byDir.has(r.dirId)) byDir.set(r.dirId, []);
    byDir.get(r.dirId).push(r);
  }
  const out = { checked: 0, mismatch: [] };
  for (const [dirId, rs] of byDir) {
    try {
      const res = await dispatch("QueryAllFiles", {
        spaceType, parentDirectoryId: dirId, pageNum: 0, pageSize: 1000,
      }, opts);
      const files = res?.RSP?.DATA?.files || [];
      for (const r of rs) {
        out.checked++;
        const local = statSync(r.path).size;
        const hit = files.find((f) => f.fid === r.fid);
        if (!hit) out.mismatch.push(`${r.path}: 云端目录中未找到（fid ${String(r.fid).slice(0, 10)}…）`);
        else if (Number(hit.size) !== local) out.mismatch.push(`${r.path}: 本地 ${local}B ≠ 云端 ${hit.size}B`);
      }
    } catch (e) {
      out.mismatch.push(`目录 ${dirId} 校验失败: ${e?.message || e}`);
    }
  }
  return out;
}

/** 上传/镜像共用：校验结果汇报，有问题置退出码 */
function reportVerify(v) {
  if (!v.checked) return;
  if (v.mismatch.length) {
    v.mismatch.forEach((m) => console.error(`  ⚠️ ${m}`));
    process.exitCode = 1;
  } else {
    console.log(`✓ 云端校验通过（${v.checked} 个文件大小一致）`);
  }
}

// ---------------------------------------------------------------- 进度条与 ETA

function fmtDur(s) {
  if (!isFinite(s) || s <= 0) return "00:00";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, "0"), sss = String(ss).padStart(2, "0");
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

/**
 * 单行字节进度条（限频重绘，EWMA 平滑速率，ETA 按当前速率推算）
 * 用法：const bar = makeBar(label, totalBytes); bar(done); bar.finish(note)
 */
function fmtShareTime(s) {
  const t = String(s || "");
  if (!/^\d{14}$/.test(t)) return t || "?";
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`;
}

function makeBar(label, totalBytes) {
  // 非 TTY（Agent 管道/重定向）静默重绘，只保留 finish 一行——避免污染调用方输出
  const TTY = !!process.stdout.isTTY;
  let total = totalBytes;
  const t0 = Date.now();
  let lastT = t0, lastB = 0, rate = 0, lastDraw = 0;
  const draw = (done) => {
    if (!TTY) return;
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    if (dt >= 0.4 && done >= lastB) {
      const inst = (done - lastB) / dt;
      rate = rate > 0 ? rate * 0.7 + inst * 0.3 : inst;
      lastT = now; lastB = done;
    }
    if (now - lastDraw < 120 && done < total) return;   // ~8fps 限频
    lastDraw = now;
    const pct = total ? Math.min(1, done / total) : 0;
    const filled = Math.round(pct * 24);
    const bar = "█".repeat(filled) + "░".repeat(24 - filled);
    const eta = rate > 0 && done < total ? (total - done) / rate : 0;
    process.stdout.write(`\r${label} ${bar} ${String(Math.round(pct * 100)).padStart(3)}%  ` +
      `${fmtSize(done)}/${fmtSize(total)}  ${fmtSize(rate)}/s  ETA ${fmtDur(eta)}\x1b[K`);
  };
  draw.setTotal = (t) => { total = t; };
  draw.finish = (note = "") => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (!TTY) {
      console.log(`${label} 完成（${fmtSize(total)}，${sec}s）${note}`);
      return;
    }
    process.stdout.write(`\r\x1b[K${label} 完成（${fmtSize(total)}，${sec}s）${note}\n`);
  };
  return draw;
}

/** 在进度条上方打一行日志（先清条再打印，下个 tick 会重绘） */
function logAbove(line) {
  if (!process.stdout.isTTY) { console.log(line); return; }
  process.stdout.write(`\r\x1b[K`);
  console.log(line);
}

// ---------------------------------------------------------------- 命令实现

/** 单命令用法（wocloud help <命令> / wocloud <命令> --help）——对 Agent 的上下文账单友好 */
const USAGE = {
  login: "login [--image]   扫码登录：终端出二维码 → 手机「联通云盘」App 扫一扫确认；--image 出图片文件",
  doctor: "doctor   健康检查：Node/凭证/鉴权/续期链路/容量",
  whoami: "whoami   当前登录用户信息",
  usage: "usage [--json]   容量使用情况",
  ls: "ls [--dir <id>] [--limit <n>] [--json]   列目录（默认美化视图，--json 原始结构；根目录 id=0）",
  tree: "tree [--dir <id>] [--depth <n>] [--json]   递归目录树与占用",
  find: "find <关键字> [--json]   搜索文件（结果含 fid，供 download/分享）",
  "by-type": "by-type <1|2|3|4|5> [--dir <id>] [--page <n>] [--limit <n>] [--json]   按类型浏览：1图 2视频 3音频 4文档 5其它",
  path: "path [--dir <id>]   目录 id → 可读路径（面包屑）",
  du: "du [--dir <id>] [--json?]   子目录占用排行（降序），空间治理入口",
  versions: "versions <文件id> [--limit 10] [--json]   文件历史版本",
  download: "download <fid> [--out <路径>] [--segments 32]   取直链；--out 分段并行下载（进度+ETA+自动换链）",
  upload: "upload <文件...> [--dir <id>] [--concurrency 6] [--files 5] [--retry 3] [--no-verify]   上传（进度+断点续传+事后校验）",
  push: "push <本地目录> --to <目录id> [--files 5] [--concurrency 6] [--no-verify]   递归上传并镜像目录结构",
  mirror: "mirror <云盘目录id> <本地路径> [--dry-run] [--files 3] [--segments 32]   增量镜像到本地（并发+分段+校验）",
  cp: "cp <id...> --to <目录id> [--dir]   复制（非破坏性）",
  mkdir: "mkdir <名称> [--dir <id>]   新建目录",
  rename: "rename <id> <新名字> [--dir] [--version <n>] [--yes]   重命名（文件必须 --version，默认预演）",
  "batch-rename": "batch-rename <id...> --parent <目录id> [--types 1,0] [--prefix] [--suffix] [--index] [--yes]   批量重命名（异步任务，默认预演）",
  rm: "rm <id...> [--dir] [--recursive] [--version <n>] [--yes]   删除到回收站（默认预演；文件必须 --version）",
  mv: "mv <id...> --to <目录id> [--dir] [--version <n>] [--yes]   移动（默认预演）",
  fav: "fav <文件id...> [--dir-ids <id,id>] [--cancel]   收藏/取消收藏",
  "fav-list": "fav-list [--page 0] [--limit 50] [--json]   收藏列表",
  share: "share <文件id...> [--dirs <id,id>] [--days 7] [--no-auto-fill]   创建分享链接（返回链接+提取码）",
  "share-list": "share-list [--page 1] [--limit 20] [--json]   我的分享列表",
  unshare: "unshare <shareId...> [--delete]   取消分享（--delete 连记录删除）",
  trash: "trash [--limit 100] [--json] [--soon-days 2]   回收站列表（deleteNo 供 restore/purge）",
  restore: "restore <deleteNo...> [--yes]   回收站还原",
  purge: "purge <deleteNo...> [--yes] [--soon-days 2]   彻底删除（不可恢复，清空前统计到期）",
  "empty-trash": "empty-trash [--yes] [--soon-days 2]   清空回收站（不可恢复，清空前统计到期）",
  token: "token [--save|--refresh|--export] [--push|--pull [--relay <url> --key <口令>]]   凭证管理（relay 模式由服务器续期）",
  post: "post <路径> [jsonBody]   直连 panservice POST（调试）",
  raw: "raw <业务key> [jsonBody]   直调任意 dispatcher 接口（调试/逃生舱）",
};

async function run(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];

  const helpTarget = cmd === "help" ? args._[1] : (args.help ? cmd : null);
  if (!cmd || (cmd === "help" && !helpTarget)) { console.log(HELP); return; }
  if (helpTarget) {
    console.log(USAGE[helpTarget]
      ? `用法: node wocloud.mjs ${USAGE[helpTarget]}`
      : `未知命令或无单独说明: ${helpTarget}（node wocloud.mjs help 看全部）`);
    return;
  }

  const session = resolveSession(args.token);
  const needToken = !["token", "login", "doctor"].includes(cmd);
  if (needToken && !session?.accessToken) {
    console.error("✗ 未找到可用 token。三种解决方式：");
    console.error("  ① 本机装官方客户端并登录（自动读取）");
    console.error("  ② export WOCLOUD_TOKEN=<accessToken>");
    console.error("  ③ 把其他设备导出的 credentials.json 放到 ~/.wocloud/credentials.json");
    process.exit(1);
  }
  const opts = {
    token: session?.accessToken,
    refreshToken: session?.refreshToken,
    clientId: args["client-id"] || CLIENT_IDS.mac,
    secretKey: args.secret || SECRETS.mac,
  };

  // 单目录文件数上限预检：只提示不阻断（memberLevel → 等级 的映射是推断的）
  async function warnFileLimit(perDirCounts) {
    const max = Math.max(0, ...perDirCounts);
    if (max <= 100) return;   // 最低档就是 100，没超就不用查
    try {
      const [cfg, usage] = await Promise.all([
        querySysConfig(opts),
        postApi("/api/bff/member/info/card/storage", {}, opts),
      ]);
      const level = Number(usage?.result?.memberLevel);
      const key = Number.isFinite(level) && level % 100 === 0 ? String(level / 100) : null;
      const limit = key ? Number(cfg.vip_level_file_num_limit?.[key]) : NaN;
      if (Number.isFinite(limit) && limit > 0 && max > limit) {
        console.log(`⚠️ 单个目录将写入 ${max} 个文件，账号配置的参考上限是 ${limit} 个/目录（memberLevel=${level}）`);
        console.log("   ↳ 2026-10-26 实测 101 个可正常上传，该配置值不是硬限制；仅作提醒（详见 wocloud limits）");
      }
    } catch {
      // 预检失败不影响上传
    }
  }

  // ---- 回收站「即将到期」统计 ----
  // keepDays 是服务端按条下发的剩余保留天数（本账号实测一级 15 天，与 limits 表里的 7 天不一致，
  // 所以只认条目自己的 keepDays，不信配置表）。
  const SOON_DAYS = Number(args["soon-days"] ?? 2);

  async function fetchRecycleAll(spaceType = "0") {
    // 坑：deleteTime 相同的条目排序不稳定，翻页会重复回同一批（实测 105 条翻出 2000 条重复）。
    // 所以按 deleteNo 去重，连续两页没有新条目就停。
    const seen = new Set();
    const all = [];
    let zeroStreak = 0;
    for (let pageNum = 0; pageNum < 50; pageNum++) {
      const res = await dispatch("QueryRecycleData", { spaceType, pageNum, pageSize: 100 }, opts);
      const list = res?.RSP?.DATA;
      if (!Array.isArray(list) || !list.length) break;
      let added = 0;
      for (const it of list) {
        if (!it?.deleteNo || seen.has(it.deleteNo)) continue;
        seen.add(it.deleteNo);
        all.push(it);
        added++;
      }
      if (added === 0) {
        if (++zeroStreak >= 2) break;
      } else {
        zeroStreak = 0;
      }
      if (list.length < 100) break;
    }
    return all;
  }

  /** 打印即将到期的条目；传 deleteNos 时只看这些条目 */
  async function printRecycleSoon(deleteNos = null) {
    try {
      const all = await fetchRecycleAll();
        const targets = deleteNos ? all.filter((it) => deleteNos.includes(it.deleteNo)) : all;
        const missing = deleteNos ? deleteNos.filter((no) => !all.some((it) => it.deleteNo === no)) : [];
      if (missing.length) {
        console.log(`⚠️ ${missing.length} 个 deleteNo 不在回收站（可能已被清除或已到期）`);
      }
      if (!deleteNos) console.log(`回收站共 ${targets.length} 项`);
      const soon = targets.filter((it) => Number(it.keepDays) <= SOON_DAYS);
      if (soon.length) {
        console.log(`⏳ ${targets.length} 项里 ${soon.length} 项将在 ${SOON_DAYS} 天内到期（到期自动清除，不 purge 也会消失）：`);
        for (const it of soon.slice(0, 10)) {
          console.log(`   ${it.name}  剩余 ${it.keepDays} 天  deleteNo=${it.deleteNo}`);
        }
        if (soon.length > 10) console.log(`   … 还有 ${soon.length - 10} 项`);
      } else if (deleteNos) {
        console.log(`✓ 待处理 ${targets.length} 项都不在 ${SOON_DAYS} 天到期窗口内`);
      }
      return { all, targets, soon, missing };
    } catch (e) {
      console.log(`（到期统计失败，不影响执行：${e?.message || e}）`);
      return null;
    }
  }

  switch (cmd) {
    case "login": {
      // 扫码登录：generate → 渲染二维码 → 2s 轮询 → state 3 落盘 → whoami 自检
      console.log("打开「联通云盘」App →【我的】→ 右上角扫一扫，扫描下方二维码并确认登录：\n");
      for (let round = 0; round < 5; round++) {
        const qr = await qrGenerate();
        if (args.image) {
          mkdirSync(CREDS_DIR, { recursive: true });
          const pngPath = join(CREDS_DIR, "login-qr.png");
          writeFileSync(pngPath, Buffer.from(qr.image, "base64"));
          console.log(`二维码已保存：${pngPath}（请用图片查看器打开后扫码）`);
        } else {
          try {
            console.log(renderQr(qrModules(decodePng(Buffer.from(qr.image, "base64")))));
          } catch (e) {
            mkdirSync(CREDS_DIR, { recursive: true });
            const pngPath = join(CREDS_DIR, "login-qr.png");
            writeFileSync(pngPath, Buffer.from(qr.image, "base64"));
            console.log(`（终端渲染失败: ${e.message}）二维码已保存，请打开扫码：${pngPath}`);
          }
        }
        console.log(`\n二维码 60 秒自动刷新 · 等待扫码…（Ctrl-C 取消）`);
        const deadline = Date.now() + 60_000;
        let logged = null, scannedNotified = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          let st;
          try { st = await qrQuery(qr.uuid); } catch { continue; }   // 网络抖动，继续轮询
          if (st.state === 2 && !scannedNotified) {
            scannedNotified = true;
            console.log("  ✓ 已扫码，请在手机上确认登录…");
          } else if (st.state === 3) { logged = st; break; }
          else if (st.state === 4) break;   // 过期 → 换码
        }
        if (logged?.token) {
          saveCredentials({
            accessToken: logged.token,
            refreshToken: logged.refreshToken || null,
            savedAt: Date.now(),
          });
          console.log(`\n✓ 登录成功，凭证已保存 -> ${CREDS_FILE}`);
          const r = await dispatch("AppQueryUser", { accessToken: logged.token },
            { token: logged.token, profile: "user", autoRefresh: false });
          const u = r?.RSP?.DATA;
          if (r?.RSP?.RSP_CODE === "0000") {
            console.log(`✓ 自检通过：${u?.userName}（${u?.userId}），现在可以直接使用全部命令`);
          } else {
            console.log(`⚠️ 自检未通过（RSP_CODE=${r?.RSP?.RSP_CODE}）。凭证已保存，请稍后重试 node wocloud.mjs whoami`);
          }
          return;
        }
        console.log("\n二维码已过期，重新生成…\n");
      }
      console.error("✗ 连续 5 张二维码均未完成扫码登录");
      process.exit(1);
    }
    case "token": {
      // —— relay 中转：push/pull（三端共用一份凭证；服务器负责续期）——
      if (args.push || args.pull) {
        const saved = loadRelayConfig();
        const url = String(args.relay || saved?.url || "").replace(/\/+$/, "");
        const key = String(args.key || saved?.key || "");
        if (!url || !key) {
          console.error("用法: wocloud token --push --relay <url> --key <口令>   /   token --pull --relay <url> --key <口令>");
          console.error("  配过一次后会写入 ~/.wocloud/relay.json，以后可省略 --relay/--key。");
          process.exit(1);
        }
        const headers = { "Content-Type": "application/json", "X-Relay-Key": key };
        if (args.push) {
          const s2 = resolveSession(args.token);
          if (!s2?.accessToken) { console.error("✗ 本机没有可用凭证，先 login 或 --save"); process.exit(1); }
          const res = await fetch(`${url}/credentials`, {
            method: "POST", headers,
            body: JSON.stringify({
              accessToken: s2.accessToken,
              refreshToken: s2.refreshToken || null,
              savedAt: Date.now(),
            }),
            signal: AbortSignal.timeout(15_000),
          }).catch((e) => { console.error(`✗ 连不上 relay: ${e?.message || e}`); process.exit(1); });
          if (res.status !== 200) {
            console.error(`✗ 推送失败: HTTP ${res.status} ${await res.text().catch(() => "")}`);
            process.exit(1);
          }
          saveRelayConfig({ url, key });
          console.log(`✓ 已推送到 ${url}`);
          console.log("  服务器 token-keeper 会自动续期；其余设备 token --pull 即可共用。");
          break;
        }
        // pull
        const res = await fetch(`${url}/credentials`, {
          headers, signal: AbortSignal.timeout(15_000),
        }).catch((e) => { console.error(`✗ 连不上 relay: ${e?.message || e}`); process.exit(1); });
        if (res.status === 404) { console.error("✗ relay 上还没有凭证：先在已登录设备 token --push"); process.exit(1); }
        if (res.status === 403) { console.error("✗ 口令不对（HTTP 403）"); process.exit(1); }
        if (!res.ok) { console.error(`✗ 拉取失败: HTTP ${res.status}`); process.exit(1); }
        const creds = await res.json().catch(() => null);
        if (!creds?.accessToken) { console.error("✗ relay 返回内容不合法"); process.exit(1); }
        saveCredentials({
          accessToken: creds.accessToken,
          refreshToken: null,             // 续期权归服务器，本地不留 refreshToken
          savedAt: Number(creds.savedAt) || Date.now(),
        });
        saveRelayConfig({ url, key });
        console.log(`✓ 已拉取并保存 -> ${CREDS_FILE}（签发于 ${new Date(creds.savedAt).toLocaleString()}，via ${creds.via || "push"}）`);
        const r = await dispatch("AppQueryUser", { accessToken: creds.accessToken },
          { token: creds.accessToken, profile: "user", autoRefresh: false });
        if (r?.RSP?.RSP_CODE === "0000") {
          console.log(`✓ 自检通过：${r.RSP.DATA?.userName}`);
          console.log("  之后本机遇 1001 会自动向 relay 取最新 token（续期由服务器负责，本地不再抢）");
        } else {
          console.log(`⚠️ 自检未通过（${r?.RSP?.RSP_CODE ?? "网络异常"}）：凭证已保存，token-keeper 续期后再试`);
        }
        break;
      }
      if (args.refresh) {
        const fresh = await refreshSession(session);
        if (!fresh) {
          console.error("✗ 刷新失败（exchange 与 refreshToken 两条路都没拿到新 token）");
          process.exit(1);
        }
        console.log(`✓ 已刷新并保存 -> ${CREDS_FILE}（via ${fresh.via}）`);
        printTokenInfo({ ...fresh, source: session.source, savedAt: loadCredentials()?.savedAt });
        break;
      }
      if (!session) {
        console.error("✗ 未找到任何 token。用 --token / WOCLOUD_TOKEN 提供，或在本机客户端登录。");
        process.exit(1);
      }
      if (args.save) {
        saveCredentials({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken || null,
          savedAt: Date.now(),
        });
        console.log(`✓ 已保存 -> ${CREDS_FILE}`);
        console.log("  把这个文件复制到其他设备的 ~/.wocloud/credentials.json 即可免登录使用。");
        console.log("");
      }
      if (args.export) {
        const c = loadCredentials();
        if (!c) { console.error("✗ 还没有 credentials.json，先 --save"); process.exit(1); }
        console.log(JSON.stringify(c, null, 2));
        break;
      }
      printTokenInfo(session);
      break;
    }
    case "whoami": {
      // 对应 app.js: user/getUserInfo → AppQueryUser({accessToken})，走 api-user dispatcher
      printResult(await dispatch("AppQueryUser", { accessToken: opts.token }, { ...opts, profile: "user" }));
      break;
    }
    case "ls": {
      const dir = args.dir || "0";
      // 对应 app.js getChildrenFiles → QueryAllFiles({spaceType,parentDirectoryId,pageNum,pageSize})
      // ⚠️ 服务端单页有上限，pageSize 可用 --limit 调大（默认 100，最大建议 1000）
      const res = await dispatch("QueryAllFiles", {
        spaceType: "0",
        parentDirectoryId: dir,
        pageNum: 0,
        pageSize: Number(args.limit ?? 100),
      }, opts);
      const files = res?.RSP?.DATA?.files;
      if (args.json || !Array.isArray(files)) { printResult(res); break; }
      const fmtT = (t) => {
        const s = String(t || "");
        return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "";
      };
      for (const f of files) {
        if (f.type === 0) console.log(`📁 ${f.name}/  id=${f.id}`);
        else console.log(`📄 ${f.name}  ${fmtSize(Number(f.size) || 0)}  ${fmtT(f.modifyTime || f.lastModifyTime)}  id=${f.id}  fid=${f.fid}`);
      }
      const nd = files.filter((f) => f.type === 0).length;
      console.log(`── ${files.length} 项（${nd} 目录 / ${files.length - nd} 文件）· --json 看原始结构`);
      break;
    }
    case "find": {
      const kw = args._[1];
      if (!kw) { console.error("缺少搜索关键字"); process.exit(1); }
      // 对应 app.js 搜索页 → SearchFileV3({searchType,keyWord,pageNo,pageSize})
      const res = await dispatch("SearchFileV3", {
        searchType: "0",          // 0=全部 1=家庭空间
        keyWord: kw,
        pageNo: 1,
        pageSize: 50,
      }, opts);
      const rows = res?.RSP?.DATA?.result;
      if (args.json || !Array.isArray(rows)) { printResult(res); break; }
      for (const f of rows) {
        const loc = f.directoryName ? `  在 ${f.directoryName}/` : "";
        console.log(`📄 ${f.fileName}  ${fmtSize(Number(f.fileSize) || 0)}${loc}`);
        console.log(`   id=${f.id}   fid=${f.fid}`);
      }
      console.log(`── 命中 ${rows.length} 项 · fid 用于 download/分享`);
      break;
    }
    case "upload": {
      const paths = args._.slice(1);
      if (!paths.length) {
        console.error("用法: wocloud upload <文件...> [--dir <id>] [--concurrency <n>] [--files <n>] [--retry <n>]");
        console.error("  支持同时传多个文件：upload a.txt b.mp3 c.iso --dir <id>");
        process.exit(1);
      }
      const missing = paths.filter((p) => !existsSync(p));
      if (missing.length) { console.error(`文件不存在: ${missing.join(", ")}`); process.exit(1); }
      const notFile = paths.filter((p) => !statSync(p).isFile());
      if (notFile.length) { console.error(`不是文件: ${notFile.join(", ")}`); process.exit(1); }

      const dirId = args.dir || "0";
      await warnFileLimit([paths.length]);
      const sem = makeSemaphore(GLOBAL_MAX_INFLIGHT);
      const multi = paths.length > 1;
      // 聚合进度条：按文件字节数汇总（分片级回调按比例折算）
      const sized = paths.map((p) => ({ name: basename(p), size: statSync(p).size }));
      const totalAll = sized.reduce((a, b) => a + b.size, 0);
      const byName = new Map(sized.map((x) => [x.name, x]));
      const fileAgg = new Map();
      let agg = 0;
      const bar = makeBar(multi ? `上传 ${paths.length} 个文件` : `上传 ${basename(paths[0])}`, totalAll);
      const r = await uploadItems(paths.map((p) => ({ path: p, dirId })), {
        token: opts.token,
        spaceType: args.space || "0",
        chunkConc: Math.max(1, Number(args.concurrency ?? DEFAULT_CONCURRENCY)),
        fileConc: Math.max(1, Number(args.files ?? DEFAULT_FILE_CONCURRENCY)),
        maxRetry: Math.max(1, Number(args.retry ?? MAX_RETRY)),
        sem,
        onProgress: (name, done, total) => {
          const f = byName.get(name);
          if (!f || !total) return;
          const bytes = Math.round(f.size * done / total);
          const prev = fileAgg.get(name) || 0;
          agg += bytes - prev;
          fileAgg.set(name, bytes);
          bar(agg);
        },
        onLog: (line) => logAbove(line),
      });
      if (args.json) {
        // 结构化输出：bulk/Agent 消费（人读走默认路径）。含事后大小校验结果。
        const vr = await verifyUploads(r.results, opts, args.space || "0");
        console.log(JSON.stringify({
          ok: !r.failCount,
          okCount: r.okCount, skipCount: r.skipCount, failCount: r.failCount,
          verify: { checked: vr.checked ?? 0, mismatch: vr.mismatch ?? [] },
          results: (r.results ?? []).map((x) => ({
            file: x.path, ok: !!x.ok, skipped: !!x.skipped,
            fid: x.fid ?? null, error: x.error ?? null,
          })),
        }));
        if (r.failCount) process.exitCode = 1;
        break;
      }
      bar.finish(`，成功 ${r.okCount} · 秒传 ${r.skipCount} · 失败 ${r.failCount}`);
      if (!multi && r.results?.[0]?.ok && !r.results[0].skipped && r.results[0].fid) {
        console.log(`fid: ${r.results[0].fid}`);
      }
      if (!args["no-verify"]) reportVerify(await verifyUploads(r.results, opts, args.space || "0"));
      if (r.failCount) process.exitCode = 1;
      break;
    }
    case "push": {
      // 递归上传本地目录，自动在云端建出同样的目录结构
      const localDir = args._[1];
      if (!localDir || !existsSync(localDir) || !statSync(localDir).isDirectory()) {
        console.error("用法: wocloud push <本地目录> --to <云盘目录id> [--concurrency <n>] [--files <n>]");
        process.exit(1);
      }
      const targetId = args.to || "0";
      const spaceType = args.space || "0";

      const scanned = scanLocal(localDir);
      if (!scanned.length) { console.log("没有可上传的文件（已跳过系统/临时文件）"); break; }
      {
        const perDir = new Map();
        for (const f of scanned) {
          const d = f.rel.split("/").slice(0, -1).join("/");
          perDir.set(d, (perDir.get(d) || 0) + 1);
        }
        await warnFileLimit([...perDir.values()]);
      }
      console.log(`扫描到 ${scanned.length} 个文件，开始建立云端目录结构`);

      // 需要的目录（相对路径，按层级排序，父目录先建）
      const relDirs = [...new Set(
        scanned.map((f) => f.rel.split("/").slice(0, -1).join("/")),
      )].filter(Boolean).sort((a, b) => a.split("/").length - b.split("/").length);

      const dirMap = new Map([["", targetId]]);
      for (const rel of relDirs) {
        const parts = rel.split("/");
        const parent = dirMap.get(parts.slice(0, -1).join("/")) ?? targetId;
        const name = parts[parts.length - 1];
        const res = await dispatch("CreateDirectory", {
          spaceType, parentDirectoryId: parent, directoryName: name,
          deviceNo: args.device || "", clientType: 1,
        }, opts);
        const id = res?.RSP?.DATA?.id;
        if (id) {
          dirMap.set(rel, id);
          console.log(`  📁 ${rel}`);
        } else {
          console.error(`  ✗ 建目录失败: ${rel} (${res?.RSP?.RSP_DESC ?? "未知错误"})`);
        }
      }

      // 静默降级修复：父目录创建失败的文件直接跳过并告警，绝不回退到 targetId（根目录）
      const items = [];
      let skippedNoDir = 0;
      for (const f of scanned) {
        const parentKey = f.rel.split("/").slice(0, -1).join("/");
        const dirId = dirMap.get(parentKey);
        if (dirId === undefined && parentKey !== "") {
          console.error(`  ⚠️ 跳过 ${f.rel}（父目录创建失败，拒绝回退根目录）`);
          skippedNoDir++;
          continue;
        }
        items.push({ path: f.abs, dirId: dirId ?? targetId });
      }
      if (skippedNoDir) {
        console.error(`  ⚠️ 共跳过 ${skippedNoDir} 个文件（父目录创建失败）— 请用 tools/wocloud-bulk.mjs 先补目录`);
        process.exitCode = 1;
      }

      const sem = makeSemaphore(GLOBAL_MAX_INFLIGHT);
      const totalAll = items.reduce((a, it) => a + statSync(it.path).size, 0);
      const byName = new Map(items.map((it) => [basename(it.path), { name: basename(it.path), size: statSync(it.path).size }]));
      const fileAgg = new Map();
      let agg = 0;
      const bar = makeBar(`上传 ${items.length} 个文件`, totalAll);
      const r = await uploadItems(items, {
        token: opts.token,
        spaceType,
        chunkConc: Math.max(1, Number(args.concurrency ?? DEFAULT_CONCURRENCY)),
        fileConc: Math.max(1, Number(args.files ?? DEFAULT_FILE_CONCURRENCY)),
        maxRetry: Math.max(1, Number(args.retry ?? MAX_RETRY)),
        sem,
        onProgress: (name, done, total) => {
          const f = byName.get(name);
          if (!f || !total) return;
          const bytes = Math.round(f.size * done / total);
          const prev = fileAgg.get(name) || 0;
          agg += bytes - prev;
          fileAgg.set(name, bytes);
          bar(agg);
        },
        onLog: (line) => logAbove(line),
      });
      bar.finish(`，成功 ${r.okCount} · 秒传 ${r.skipCount} · 失败 ${r.failCount} · 跳过 ${skippedNoDir}`);
      if (!args["no-verify"]) reportVerify(await verifyUploads(r.results, opts, spaceType));
      if (r.failCount) process.exitCode = 1;
      break;
    }
    case "mkdir": {
      const name = args._[1];
      if (!name) { console.error("缺少目录名"); process.exit(1); }
      // 对应 app.js → CreateDirectory({spaceType,familyId,parentDirectoryId,directoryName,deviceNo,clientType})
      printResult(await dispatch("CreateDirectory", {
        spaceType: args.space || "0",
        parentDirectoryId: args.dir || "0",
        directoryName: name,
        deviceNo: args.device || "",
        clientType: 1,
      }, opts));
      break;
    }
    case "rm": {
      const ids = args._.slice(1);
      if (!ids.length) {
        console.error("用法: wocloud rm <id...> [--dir] [--recursive] [--version <n>] [--yes]");
        console.error("  --dir            目标为目录（目录不需要 --version）");
        console.error("  --recursive/-r   目录非空时，先递归删除内部文件与子目录");
        console.error("  --version        文件版本号，默认 1（见 ls 输出的 fileVersion 字段）");
        console.error("  ⚠️ 传文件要短 id（ls 输出里的 id=），传 fid 会「成功但没删」");
        console.error("  --yes            真正执行（默认只预演）");
        process.exit(1);
      }
      const isDir = !!args.dir;
      const space = args.space || "0";
      const recursive = !!args.recursive || !!args.r;

      const buildPayload = (fileIds, dirIds) => {
        const p = {
          taskType: "DELETE",
          sourceSpaceType: space,
          targetSpaceType: space,
          sourceFileIds: fileIds,
          sourceDirectoryIds: dirIds,
          targetDirectoryId: "",
          targetFamilyId: "",
          sourceFamilyId: "",
          deviceNo: args.device || "",
          clientType: 1,
        };
        if (dirIds.length) p.notEmptyDir = 1;
        return p;
      };

      /** 递归收集目录内的文件与子目录（子目录按深度倒序，先删深层） */
      const collect = async (dirId) => {
        const fileIds = [];
        const dirs = [];
        const queue = [[dirId, 0]];
        while (queue.length) {
          const [cur, depth] = queue.shift();
          const res = await dispatch("QueryAllFiles", {
            spaceType: space, parentDirectoryId: cur, pageNum: 0, pageSize: 1000,
          }, opts);
          const files = res?.RSP?.DATA?.files || [];
          const subdirs = [];
          for (const f of files) {
            if (f.type === 0) subdirs.push(f.id);
            else fileIds.push(f.id);
          }
          if (cur !== dirId) dirs.push({ id: cur, depth });
          else dirs.push({ id: cur, depth: -1 });   // 根目录排最后删
          for (const d of subdirs) queue.push([d, depth + 1]);
        }
        dirs.sort((a, b) => b.depth - a.depth);
        return { fileIds, dirIds: dirs.map((d) => d.id) };
      };

      let plan = [];
      if (isDir) {
        if (recursive) {
          for (const id of ids) {
            const c = await collect(id);
            if (c.fileIds.length) plan.push(buildPayload(c.fileIds, []));
            // 目录逐个删：每个目录在轮到时已空，且父子同批可能被拒
            for (const d of c.dirIds) plan.push(buildPayload([], [d]));
          }
        } else {
          const res = await dispatch("QueryAllFiles", {
            spaceType: space, parentDirectoryId: ids[0], pageNum: 0, pageSize: 1000,
          }, opts);
          const n = (res?.RSP?.DATA?.files || []).length;
          if (n > 0 && ids.length === 1) {
            console.error(`✗ 目录下还有 ${n} 项，服务端拒绝删除（错误码 5056）`);
            console.error(`  如需连同内容一起删除，请加 --recursive`);
            process.exit(1);
          }
          plan.push(buildPayload([], ids));
        }
      } else {
        plan.push(buildPayload(ids, []));
      }

      if (!args.yes) {
        console.log("⚠️  预演模式（未执行任何删除）");
        for (const p of plan) {
          console.log("将调用 POST /wohome/pass/file/batch/createTask，参数：");
          console.log(JSON.stringify(p, null, 2));
        }
        console.log("\n确认无误后，加 --yes 真正执行。");
        break;
      }
      let failed = 0;
      for (const p of plan) {
        const res = await postApi("/wohome/pass/file/batch/createTask", p, opts);
        if (res?.meta?.code !== "200") {
          console.error(`✗ ${res?.meta?.code} ${res?.meta?.message}`);
          failed++;
        }
      }
      if (!failed) {
        console.log(plan.length > 1
          ? `✓ 已删除（${plan.length} 个批次）`
          : "✓ 已删除");
      }
      break;
    }
    case "mv": {
      const ids = args._.slice(1);
      const to = args.to;
      if (!ids.length || !to) {
        console.error("用法: wocloud mv <id...> --to <目标目录id> [--dir] [--version <n>] [--yes]");
        console.error("  --to       目标目录 id（根目录为 0）");
        console.error("  --dir      目标为目录");
        console.error("  --version  文件版本号，默认 1（见 ls 输出的 fileVersion 字段）");
        console.error("  --yes      真正执行（默认只预演）");
        process.exit(1);
      }
      const isDir = !!args.dir;
      const payload = {
        taskType: "MOVE",
        sourceSpaceType: args.space || "0",
        targetSpaceType: args.space || "0",
        sourceFileIds: isDir ? [] : ids,
        sourceDirectoryIds: isDir ? ids : [],
        targetDirectoryId: to,
        targetFamilyId: "",
        sourceFamilyId: "",
        deviceNo: args.device || "",
        clientType: 1,
      };
      if (isDir) payload.notEmptyDir = 0;
      else payload.fileVersion = Number(args.version ?? 1);
      if (!args.yes) {
        console.log("⚠️  预演模式（未执行任何移动）");
        console.log("将调用 POST /wohome/pass/file/batch/createTask，参数：");
        console.log(JSON.stringify(payload, null, 2));
        console.log("\n确认无误后，加 --yes 真正执行。");
        break;
      }
      printResult(await postApi("/wohome/pass/file/batch/createTask", payload, opts));
      break;
    }
    case "du": {
      // 子目录占用排行（治理视图：谁占的空间最大），数据 = 递归聚合 QueryAllFiles
      // 全树并行：信号量只包单次请求（4 路在飞），递归本身不占槽——
      // 否则父任务抱着槽等子任务、子任务排队等槽 → 经典递归信号量死锁
      const root = args.dir || "0";
      const sem = makeSemaphore(4);
      async function aggDir(dirId) {
        const res = await sem(() => dispatch("QueryAllFiles", {
          spaceType: args.space || "0", parentDirectoryId: dirId,
          pageNum: 0, pageSize: 1000,
        }, opts));
        const list = res?.RSP?.DATA?.files || [];
        const subdirs = list.filter((f) => f.type === 0);
        const sub = await Promise.all(subdirs.map((f) => aggDir(f.id)));
        let size = 0, files = 0, dirs = subdirs.length;
        for (const s of sub) { size += s.size; files += s.files; dirs += s.dirs; }
        for (const f of list) {
          if (f.type !== 0) { size += Number(f.size) || 0; files++; }
        }
        return { size, files, dirs };
      }
      const res = await dispatch("QueryAllFiles", {
        spaceType: args.space || "0", parentDirectoryId: root,
        pageNum: 0, pageSize: 1000,
      }, opts);
      const list = res?.RSP?.DATA?.files;
      if (!Array.isArray(list)) { printResult(res); break; }
      if (list.filter((f) => f.type === 0).length > 5) {
        console.error("递归聚合全盘子目录中（4 路并发，大目录约 1~2 分钟）…");
      }
      const subdirs = list.filter((f) => f.type === 0);
      const subResults = await Promise.all(subdirs.map((f) => aggDir(f.id)));
      const rows = subdirs.map((f, i) => ({ name: `${f.name}/`, ...subResults[i] }));
      let directSize = 0, directFiles = 0;
      for (const f of list) {
        if (f.type !== 0) { directSize += Number(f.size) || 0; directFiles++; }
      }
      rows.sort((a, b) => b.size - a.size);
      if (directFiles) rows.push({ name: "（本层直接文件）", size: directSize, files: directFiles, dirs: 0 });
      const max = rows[0]?.size || 1;
      console.log(`du ${root === "0" ? "（根目录）" : root} · 子目录占用排行（降序）：\n`);
      for (const r of rows) {
        const filled = Math.round((r.size / max) * 20);
        console.log(`${fmtSize(r.size).padStart(9)}  ${"█".repeat(filled)}${"░".repeat(20 - filled)}  ${r.name}  (${r.files} 文件${r.dirs ? ` / ${r.dirs} 子目录` : ""})`);
      }
      const total = rows.reduce((a, r) => a + r.size, 0);
      console.log(`\n合计 ${fmtSize(total)} · 空间治理配合 trash / by-type / rm --recursive 使用`);
      break;
    }
    case "download": {
      const fid = args._[1];
      if (!fid) { console.error("缺少 fid（文件唯一标识，见 ls/find 返回的 fid 字段）"); process.exit(1); }
      // V1 优先，失败自动回退 V2（两者域名可能相同，V2 只在 V1 出问题时兜底）
      const first = await getDownloadUrl(fid, { ...opts, spaceType: args.space || "0", api: args.api });
      const url = first.url;
      if (first.note) console.log(`⚠️ ${first.note}`);

      // 直链 120 分钟过期且不滑动；下载中途失效时重新签发再续传
      const renewLink = async () => {
        try {
          return (await getDownloadUrl(fid, { ...opts, spaceType: args.space || "0", api: args.api })).url;
        } catch {
          return null;
        }
      };

      if (args.out) {
        mkdirSync(dirname(args.out) || ".", { recursive: true });
        // 先探测大小拿进度条总量（downloadSegmented 内部也会探测，代价一次 0-0 请求）
        const bar = makeBar("下载", 0);
        let barReady = false;
        const r = await downloadSegmented(url, args.out, {
          segments: Math.max(1, Number(args.segments ?? 32)),
          refreshUrl: renewLink,
          onProgress: (done, total) => {
            if (!barReady && total) { barReady = true; bar.setTotal(total); }
            bar(done);
          },
        });
        if (!barReady) { bar.setTotal(r.bytes); bar(r.bytes); }
        bar.finish((r.fallback ? "（单流：服务端不支持 Range）" : `，${r.segments} 段并行`) +
          (r.linkRefreshes ? `，换链 ${r.linkRefreshes} 次` : ""));
      } else {
        console.log(url);
      }
      break;
    }
    case "tree": {
      // 递归盘点目录树
      const maxDepth = parseInt(args.depth || "4", 10);
      const rootId = args.dir || "0";
      const rows = [];
      let totalSize = 0, fileCount = 0, dirCount = 0;

      async function walk(dirId, depth) {
        if (depth > maxDepth) return;
        const res = await dispatch("QueryAllFiles", {
          spaceType: args.space || "0",
          parentDirectoryId: dirId,
          pageNum: 0,
          pageSize: 1000,
        }, opts);
        const files = res?.RSP?.DATA?.files || [];
        for (const f of files) {
          const isDir = f.type === 0;
          const size = Number(f.size) || 0;
          if (isDir) dirCount++; else { fileCount++; totalSize += size; }
          rows.push({ depth, name: f.name, isDir, size, id: f.id, fid: f.fid });
          if (isDir) await walk(f.id, depth + 1);
        }
      }

      await walk(rootId, 1);

      if (args.json) {
        console.log(JSON.stringify({ rows, fileCount, dirCount, totalSize }, null, 2));
        break;
      }

      for (const r of rows) {
        const pad = "  ".repeat(r.depth - 1);
        const mark = r.isDir ? "📁" : "📄";
        console.log(`${pad}${mark} ${r.name}${r.isDir ? "/" : `  (${fmtSize(r.size)})`}`);
      }
      console.log("");
      console.log(`目录 ${dirCount} 个 · 文件 ${fileCount} 个 · 合计 ${fmtSize(totalSize)}`);
      break;
    }
    case "mirror": {
      // 云盘目录树 → 本地（增量 + 多文件并发 + 单文件分段并行 + 大小校验）
      const remoteId = args._[1] || "0";
      const localRoot = args._[2];
      if (!localRoot) {
        console.error("用法: wocloud mirror <云盘目录id> <本地路径> [--dry-run] [--files 3] [--segments 16]");
        console.error("提示: 目录 id 用 `wocloud ls` 查看，根目录为 0");
        process.exit(1);
      }
      const dryRun = !!args["dry-run"];
      const fileConc = Math.max(1, Number(args.files ?? 3));
      const segments = Math.max(1, Number(args.segments ?? 32));
      let done = 0, skipped = 0, failed = 0, totalBytes = 0;

      // 遍历收集下载任务（增量：本地已存在且大小一致则跳过）
      const tasks = [];
      async function walk(dirId, localPath) {
        mkdirSync(localPath, { recursive: true });
        const res = await dispatch("QueryAllFiles", {
          spaceType: args.space || "0",
          parentDirectoryId: dirId,
          pageNum: 0,
          pageSize: 1000,
        }, opts);
        const files = res?.RSP?.DATA?.files || [];
        for (const f of files) {
          const target = join(localPath, safeName(f.name));
          if (f.type === 0) { await walk(f.id, target); continue; }

          const size = Number(f.size) || 0;
          if (existsSync(target)) {
            try {
              if (statSync(target).size === size) { skipped++; continue; }
            } catch { /* 继续下载 */ }
          }
          if (dryRun) {
            done++; totalBytes += size;
            console.log(`[dry-run] ${target}  (${fmtSize(size)})`);
            continue;
          }
          tasks.push({ fid: f.fid, size, target });
        }
      }

      await walk(remoteId, localRoot);

      // 并发下载（多文件并发 × 单文件分段并行），聚合字节进度条
      const totalAll = tasks.reduce((a, t) => a + t.size, 0);
      const bar = makeBar(`镜像 ${tasks.length} 个文件`, totalAll);
      const fileAgg = new Map();
      let agg = 0;
      await runPool(tasks, fileConc, async (t) => {
        try {
          const first = await getDownloadUrl(t.fid, { ...opts, spaceType: args.space || "0", api: args.api });
          if (first.note) logAbove(`⚠️ ${t.target}: ${first.note}`);
          const url = first.url;
          const renewLink = async () => {
            try {
              return (await getDownloadUrl(t.fid, { ...opts, spaceType: args.space || "0", api: args.api })).url;
            } catch {
              return null;
            }
          };
          const { bytes } = await downloadSegmented(url, t.target, {
            segments,
            refreshUrl: renewLink,
            onProgress: (d) => {
              const prev = fileAgg.get(t.target) || 0;
              agg += d - prev;
              fileAgg.set(t.target, d);
              bar(agg);
            },
          });
          if (t.size && bytes !== t.size) throw new Error(`下载不完整（本地 ${bytes}B ≠ 云端 ${t.size}B）`);
          done++; totalBytes += bytes;
          logAbove(`✓ ${t.target}  (${fmtSize(bytes)})`);
        } catch (e) {
          failed++;
          logAbove(`✗ ${t.target}: ${e?.message || e}`);
        }
      });
      bar.finish(`，成功 ${done} · 失败 ${failed}`);

      console.log("");
      console.log(`镜像完成: 下载 ${done} 个 · 跳过 ${skipped} 个 · 失败 ${failed} 个 · 共 ${fmtSize(totalBytes)}` +
        (dryRun ? "" : `（${fileConc} 文件并发 × ${segments} 段）`));
      if (dryRun) console.log("（--dry-run 模式，未实际写入文件）");
      break;
    }
    case "rename": {
      const id = args._[1];
      const newName = args._[2];
      if (!id || !newName) {
        console.error("用法: wocloud rename <id> <新名字> [--dir] [--version <n>] [--yes]");
        process.exit(1);
      }
      const isDir = !!args.dir;
      const payload = {
        spaceType: args.space || "0",
        type: isDir ? 0 : 1,          // 0=目录 1=文件
        id,
        name: newName,
        deviceNo: args.device || "",
        clientType: 1,
      };
      if (!isDir) payload.fileVersion = Number(args.version ?? 1);
      if (!args.yes) {
        console.log("⚠️  预演模式（未执行）。将重命名：");
        console.log(JSON.stringify(payload, null, 2));
        console.log("\n确认无误后，加 --yes 真正执行。");
        break;
      }
      printResult(await dispatch("RenameFileOrDirectory", payload, opts));
      break;
    }
    case "trash": {
      const limit = Number(args.limit ?? 100);
      if (args.json) {
        printResult(await dispatch("QueryRecycleData", {
          spaceType: args.space || "0", pageNum: 0, pageSize: limit,
        }, opts));
        break;
      }
      const all = await fetchRecycleAll(args.space || "0");
      const list = all.slice(0, limit);
      console.log(`回收站共 ${all.length} 项（显示 ${list.length} 项）：\n`);
      for (const it of list) {
        const kind = it.type === "0" ? "📁" : "📄";
        const soon = Number(it.keepDays) <= SOON_DAYS ? "  ⏳ 即将到期" : "";
        console.log(`${kind} ${it.name}  (${fmtSize(Number(it.fileSize) || 0)})${soon}`);
        console.log(`   删除于 ${it.deleteTime}   剩余保留 ${it.keepDays} 天`);
        console.log(`   deleteNo: ${it.deleteNo}\n`);
      }
      const soonCount = all.filter((it) => Number(it.keepDays) <= SOON_DAYS).length;
      if (soonCount) {
        console.log(`⏳ 其中 ${soonCount} 项将在 ${SOON_DAYS} 天内到期（到期自动清除，想留就先 restore）`);
      }
      break;
    }
    case "restore": {
      const nos = args._.slice(1);
      if (!nos.length) {
        console.error("用法: wocloud restore <deleteNo...> [--yes]");
        console.error("  deleteNo 见 `wocloud trash` 输出");
        process.exit(1);
      }
      if (!args.yes) {
        console.log("⚠️  预演模式（未执行）。将还原以下项目：");
        nos.forEach((n) => console.log("  " + n));
        console.log("\n确认无误后，加 --yes 真正执行。");
        break;
      }
      printResult(await dispatch("ReductionRecycleData", {
        spaceType: args.space || "0", deleteNos: nos,
      }, opts));
      break;
    }
    case "purge": {
      const nos = args._.slice(1);
      if (!nos.length) {
        console.error("用法: wocloud purge <deleteNo...> [--yes]");
        process.exit(1);
      }
      await printRecycleSoon(nos);
      if (!args.yes) {
        console.log("⚠️  预演模式（未执行）。将【彻底删除】（不可恢复）：");
        nos.forEach((n) => console.log("  " + n));
        console.log("\n确认无误后，加 --yes 真正执行。");
        break;
      }
      printResult(await dispatch("DeleteRecycleData", {
        spaceType: args.space || "0", deleteNos: nos,
      }, opts));
      break;
    }
    case "empty-trash": {
      await printRecycleSoon();
      if (!args.yes) {
        console.log("⚠️  预演模式（未执行）。将【清空回收站】（不可恢复）");
        console.log("确认无误后，加 --yes 真正执行。");
        break;
      }
      printResult(await dispatch("EmptyRecycleData", { spaceType: args.space || "0" }, opts));
      break;
    }
    case "usage": {
      const res = await postApi("/api/bff/member/info/card/storage", {}, opts);
      if (args.json) { printResult(res); break; }
      const r = res?.result;
      if (!r) { printResult(res); break; }
      const pct = Number(String(r.spaceUsageRatio || "0").replace("%", "")) || 0;
      const filled = Math.max(1, Math.round(pct / 2));
      const bar = "█".repeat(filled) + "░".repeat(Math.max(0, 50 - filled));
      console.log(`容量: ${r.space}   (${r.spaceUsageRatio})`);
      console.log(`[${bar}]`);
      console.log(`  已用 ${fmtSize(r.usedSpace)}  /  总计 ${fmtSize(r.allSpace)}`);
      if (r.knowledgeSpace) {
        console.log(`  知识库 ${fmtSize(r.knowledgeUsedSpace)} / ${fmtSize(r.knowledgeSpace)}`);
      }
      break;
    }
    case "limits": {
      const cfg = await querySysConfig(opts);
      const usage = await postApi("/api/bff/member/info/card/storage", {}, opts);
      const level = Number(usage?.result?.memberLevel);
      const lv = Number.isFinite(level) && level % 100 === 0 ? String(level / 100) : null;
      const fileTable = cfg.vip_level_file_num_limit || {};
      const recycleTable = cfg.vip_level_recycle_bin || {};
      if (args.json) {
        printResult({
          memberLevel: level, vipLevel: lv,
          fileNumLimit: fileTable, recycleBinDays: recycleTable,
          maxSelect: cfg.file_max_select,
        });
        break;
      }
      const fmtTable = (t) => Object.entries(t).map(([k, v]) => `${k}→${v}`).join("  ");
      console.log(`账号等级: memberLevel=${Number.isFinite(level) ? level : "未知"}`);
      console.log(`单目录文件数上限（按等级）: ${fmtTable(fileTable)}`);
      if (lv !== null && fileTable[lv] !== undefined) {
        console.log(`  ↳ 按 memberLevel 推断为等级 ${lv}：${fileTable[lv]} 个/目录`);
      }
      console.log(`回收站保留天数（按等级）: ${fmtTable(recycleTable)}`);
      if (cfg.file_max_select) console.log(`一次最多选择: ${cfg.file_max_select}`);
      break;
    }
    case "types": {
      // 服务端分类规则 vs 内置静态表（诊断 & 验证新扩展名覆盖）
      const rules = await ensureClassifyRules(opts);
      if (!rules) { console.error("取不到 ClassifyRule（已回退内置静态表）"); process.exit(1); }
      const groups = new Map();
      for (const [ext, v] of rules) {
        if (!groups.has(v.type)) groups.set(v.type, []);
        groups.get(v.type).push(ext);
      }
      const label = { "1": "图片", "2": "视频", "3": "音频", "4": "文档", "5": "其它" };
      const staticExts = new Set(Object.values(STATIC_TYPE_MAP).flat());
      const extra = [...rules.keys()].filter((e) => !staticExts.has(e)).sort();
      const missing = [...staticExts].filter((e) => !rules.has(e)).sort();
      if (args.json) {
        printResult({
          total: rules.size,
          groups: Object.fromEntries([...groups].map(([t, exts]) => [t, exts.sort()])),
          extraVsStatic: extra,
          staticOnly: missing,
        });
        break;
      }
      console.log(`服务端分类规则: ${rules.size} 种扩展名（ClassifyRule）\n`);
      for (const t of [...groups.keys()].sort()) {
        const exts = groups.get(t).sort();
        console.log(`  ${t} ${label[t] || "未知"}（${exts.length}）: ${exts.join(" ")}`);
      }
      if (extra.length) console.log(`\n  内置静态表未覆盖（${extra.length}）: ${extra.join(" ")}`);
      if (missing.length) console.log(`  仅静态表有（${missing.length}）: ${missing.join(" ")}`);
      break;
    }
    case "cp": {
      // 复制（非破坏性：只新增副本；载荷复刻客户端 taskType:"COPY"，无 fileVersion）
      const ids = args._.slice(1);
      if (!ids.length || !args.to) {
        console.error("用法: wocloud cp <id...> --to <目标目录id> [--dir]");
        process.exit(1);
      }
      const isDir = !!args.dir;
      const payload = {
        taskType: "COPY",
        sourceSpaceType: args.space || "0", targetSpaceType: args.space || "0",
        sourceFileIds: isDir ? [] : ids,
        sourceDirectoryIds: isDir ? ids : [],
        targetDirectoryId: args.to,
        targetFamilyId: "", sourceFamilyId: "",
        deviceNo: args.device || "", clientType: 1,
      };
      if (isDir) payload.notEmptyDir = 0;
      printResult(await postApi("/wohome/pass/file/batch/createTask", payload, opts));
      break;
    }
    case "batch-rename": {
      // 批量重命名（异步任务；破坏性，默认预演）
      const ids = args._.slice(1);
      if (!ids.length || !args.parent) {
        console.error("用法: wocloud batch-rename <id...> --parent <父目录id> [--types 1,1,0] [--prefix 前缀] [--suffix 后缀]");
        console.error("  [--index] [--index-position afterSuffix|beforePrefix] [--index-digits 3] [--index-start 0] [--yes]");
        console.error("  --types 与 ids 对应：1=文件 0=目录，默认全按文件处理");
        process.exit(1);
      }
      const types = (args.types ? String(args.types).split(",") : ids.map(() => "1")).map(Number);
      const plan = {
        sourceIds: ids,
        types,
        parentId: args.parent,
        deviceNo: args.device || DEFAULT_DEVICE_NO,
        clientType: 0,
        spaceType: args.space || "0",
        renameRule: {
          prefix: args.prefix || "",
          suffix: args.suffix || "",
          index: {
            enabled: !!args.index,
            position: args["index-position"] || "afterSuffix",
            digits: Number(args["index-digits"] ?? 3),
            start: Number(args["index-start"] ?? 0),
          },
        },
      };
      if (!args.yes) {
        console.log("⚠️  预演模式（未执行）。批量重命名任务参数：");
        console.log(JSON.stringify(plan, null, 2));
        console.log("\n确认无误后，加 --yes 提交。");
        break;
      }
      const res = await postApi("/wohome/open/file/batchRename", plan, opts);
      const taskId = res?.result?.taskId;
      if (taskId) console.log(`✓ 批量重命名任务已提交（taskId=${taskId}），稍后用 ls 核对结果`);
      else printResult(res);
      break;
    }
    case "fav": {
      // 收藏/取消收藏（fileList+dirList+operateStatus）
      const ids = args._.slice(1);
      const dirIds = args["dir-ids"] ? String(args["dir-ids"]).split(",") : [];
      if (!ids.length && !dirIds.length) {
        console.error("用法: wocloud fav <文件id...> [--dir-ids <目录id,目录id>] [--cancel]");
        process.exit(1);
      }
      const payload = {
        dirList: dirIds,
        fileList: ids,
        operateStatus: args.cancel ? 0 : 1,
        spaceType: args.space || "0",
      };
      printResult(await postApi("/wocloud/favorite/addAndCancelFavorite", payload, opts));
      break;
    }
    case "fav-list": {
      const res = await postApi("/wocloud/favorite/list", {
        spaceType: args.space || "0",
        page: Number(args.page ?? 0),
        pageSize: Number(args.limit ?? 50),
      }, opts);
      const list = res?.result?.fileAndDirList;
      if (args.json || !Array.isArray(list)) { printResult(res); break; }
      console.log(`收藏共 ${list.length} 项：\n`);
      for (const f of list) {
        const kind = f.type === 0 || f.type === "0" ? "📁" : "📄";
        console.log(`${kind} ${f.name || f.fileName}   id=${f.id || f.wcFileId}   收藏于 ${f.collectTime || "?"}`);
      }
      break;
    }
    case "versions": {
      // 文件历史版本（fileVersionDispatcher 网关 → /cloud/file-version/file/history/list）
      const fileId = args._[1];
      if (!fileId) { console.error("用法: wocloud versions <文件id> [--limit 10]"); process.exit(1); }
      const res = await callVersionGateway("/cloud/file-version/file/history/list", {
        size: Math.max(1, Number(args.limit ?? 10)),
        wcFileId: fileId,
      }, opts);
      const list = Array.isArray(res?.result) ? res.result : null;
      if (args.json || !list) { printResult(res); break; }
      console.log(`历史版本 ${list.length} 个：\n`);
      for (const v of list) {
        console.log(`v${v.fileVersion}  ${v.fileName}  (${fmtSize(Number(v.fileSize) || 0)})`);
        console.log(`   versionId=${v.id}  更新于 ${v.updatedTime || "?"}  ${v.operationType || ""}`);
      }
      break;
    }
    case "by-type": {
      // 按类型浏览（1=图片 2=视频 3=音频 4=文档 5=其它；不指定 --dir 时查全盘）
      const ft = args._[1];
      if (!["1", "2", "3", "4", "5"].includes(ft)) {
        console.error("用法: wocloud by-type <1|2|3|4|5> [--dir <目录id>] [--page 0] [--limit 100] [--json]");
        console.error("  1=图片 2=视频 3=音频 4=文档 5=其它");
        process.exit(1);
      }
      const pageSize = Math.min(1000, Math.max(1, Number(args.limit ?? 100)));
      const params = {
        spaceType: args.space || "0",
        fileType: ft,
        pageNum: Number(args.page ?? 0),
        pageSize,
      };
      if (args.dir) params.directoryId = args.dir;
      const res = await dispatch("QueryTypeFiles", params, opts);
      const files = res?.RSP?.DATA?.files;
      if (args.json || !Array.isArray(files)) { printResult(res); break; }
      console.log(`类型 ${ft}（${{ "1": "图片", "2": "视频", "3": "音频", "4": "文档", "5": "其它" }[ft]}）` +
        `${args.dir ? " · 目录 " + args.dir : " · 全盘"} · 本页 ${files.length} 项：\n`);
      for (const f of files) {
        const kind = f.type === 0 ? "📁" : "📄";
        console.log(`${kind} ${f.name}  (${fmtSize(Number(f.size) || 0)})  id=${f.id}  fid=${f.fid}`);
      }
      break;
    }
    case "path": {
      // 目录 id → 可读路径（面包屑；接口返回子→父，反转输出）
      const res = await dispatch("GetDirectoryPath", { directoryId: args.dir || args._[1] || "0" }, opts);
      const segs = res?.RSP?.DATA;
      if (!Array.isArray(segs)) { printResult(res); break; }
      const names = segs.map((s) => s.directoryName || s.name || s.id).reverse();
      console.log(`${args.dir || args._[1] || "0"} → ${names.join("/")}`);
      break;
    }
    case "share-info": {
      // 他人分享：元信息（匿名可读，clientSecret 加密）
      const link = args._[1];
      if (!link) {
        console.error("用法: wocloud share-info <分享链接|shareId> [--code <提取码>] [--json]");
        process.exit(1);
      }
      const r = await shareInfo(link, args.code);
      if (args.json) { printResult(r); break; }
      const inf = r.info || {};
      console.log(`分享者: ${inf.nickName || "?"}（VIP ${inf.vipLevel ?? "?"}）`);
      console.log(`状态: ${inf.invalid ? "已失效" : "有效"}${inf.invalidTime ? ` · 过期于 ${fmtShareTime(inf.invalidTime)}` : ""}`);
      console.log(`shareId: ${r.shareId}`);
      console.log(`提取码: ${r.shareCode || "无"}`);
      break;
    }
    case "share-ls": {
      // 他人分享：顶层文件列表
      const link = args._[1];
      if (!link) {
        console.error("用法: wocloud share-ls <分享链接|shareId> [--code <提取码>] [--json]");
        process.exit(1);
      }
      const r = await shareFiles(link, args.code);
      if (args.json) { printResult(r); break; }
      const TYPE_NAME = { "1": "图片", "2": "视频", "3": "音频", "4": "文档", "5": "其它" };
      console.log(`分享 ${r.shareId}${r.shareCode ? `（提取码 ${r.shareCode}）` : ""} · ${r.files.length} 项\n`);
      r.files.forEach((f, i) => {
        const kind = f.isDir ? "📁" : "📄";
        const kindName = f.isDir ? "目录" : (TYPE_NAME[f.type] || "其它");
        console.log(`${String(i + 1).padStart(2)}. ${kind} ${f.name}`);
        console.log(`    ${kindName} · ${f.isDir ? "—" : fmtSize(f.size)}${f.fid ? "" : " · 无 fid（目录需转存后再取）"}`);
      });
      break;
    }
    case "share-dl": {
      // 他人分享：取直链 / 直接下载（直链按登录态签发，必须有本地账号）
      const link = args._[1];
      if (!link) {
        console.error("用法: wocloud share-dl <分享链接|shareId> [序号|文件名] [--code <提取码>] [--out <路径>] [--segments 32]");
        console.error("  不给 --out 只打印直链；给序号/文件名可多选时指定目标");
        process.exit(1);
      }
      const r = await shareFiles(link, args.code);
      const want = args._[2];
      let file = r.files.find((f) => !f.isDir && (String(f.name) === want || String(f.name).includes(String(want || ""))));
      if (!want) {
        const downloadable = r.files.filter((f) => !f.isDir);
        if (downloadable.length !== 1) {
          console.error(`分享里有 ${downloadable.length} 个可下载文件，请指定序号或文件名：`);
          r.files.forEach((f, i) => console.error(`  ${i + 1}. ${f.name}${f.isDir ? "（目录）" : ""}`));
          process.exit(1);
        }
        file = downloadable[0];
      }
      if (!file) { console.error(`分享里没有匹配的文件: ${want}`); process.exit(1); }
      if (file.isDir) { console.error("目录内的文件暂不支持直接下载（需先转存到自己云盘）"); process.exit(1); }

      const renew = async () => shareDownloadUrl(file.fid, opts);
      const url = await renew();
      if (!args.out) { console.log(url); break; }
      const outPath = args.out;
      mkdirSync(dirname(outPath) || ".", { recursive: true });
      const bar = makeBar("下载", 0);
      let barReady = false;
      const res = await downloadSegmented(url, outPath, {
        segments: Math.max(1, Number(args.segments ?? 32)),
        refreshUrl: renew,
        onProgress: (done, total) => {
          if (!barReady && total) { barReady = true; bar.setTotal(total); }
          bar(done);
        },
      });
      if (!barReady) { bar.setTotal(res.bytes); bar(res.bytes); }
      bar.finish(`，${res.bytes} 字节`);
      break;
    }
    case "share": {
      // 创建分享链接（载荷复刻客户端：fileIds+fileFolderIds+days+autoFill）
      const ids = args._.slice(1);
      const dirIds = args.dirs ? String(args.dirs).split(",") : [];
      if (!ids.length && !dirIds.length) {
        console.error("用法: wocloud share <文件id...> [--dirs <目录id,目录id>] [--days 7] [--no-auto-fill]");
        process.exit(1);
      }
      const res = await dispatch("ShareFile", {
        // ⚠️ fileIds/fileFolderIds 是逗号拼接的字符串（客户端 dialogData 就做了 join(",")），不是数组
        fileIds: ids.join(","),
        fileFolderIds: dirIds.join(","),
        days: Number(args.days ?? 7),
        autoFill: args["no-auto-fill"] ? "2" : "1",
      }, opts);
      const d = res?.RSP?.DATA;
      if (res?.RSP?.RSP_CODE !== "0000" || !d?.shareUrl) { printResult(res); break; }
      console.log(`✓ 分享创建成功（${args.days ?? 7} 天有效）`);
      console.log(`  链接: ${d.shareUrl}`);
      console.log(`  提取码: ${d.shareCode ?? "(无)"}`);
      break;
    }
    case "share-list": {
      // 我的分享列表（{pageNum,pageSize,sortRule}，pageNum 从 1 开始）
      const res = await dispatch("AllShareFileList", {
        pageNum: Number(args.page ?? 1),
        pageSize: Number(args.limit ?? 20),
        sortRule: Number(args.sort ?? 0),
      }, opts);
      const d = res?.RSP?.DATA;
      const list = Array.isArray(d) ? d : d?.list;
      if (args.json || !Array.isArray(list)) { printResult(res); break; }
      const STATUS = { "0": "已删除", "1": "生效中", "2": "已取消", "3": "已过期" };
      console.log(`分享记录 ${list.length} 项${d?.total ? `（共 ${d.total}）` : ""}：\n`);
      for (const it of list) {
        const n = Number(it.num) || 1;
        const name = n > 1 ? `${it.fileName} 等 ${n} 个文件` : it.fileName;
        console.log(`[${STATUS[String(it.status)] ?? it.status}] ${name}`);
        console.log(`   shareId=${it.shareId}  分享于 ${it.shareTime || "?"}  ${it.invalidTime ? "过期于 " + it.invalidTime : ""}`);
      }
      break;
    }
    case "unshare": {
      // 取消分享（operType 1）/删除记录（operType 2）；shareId 逗号连接
      const ids = args._.slice(1);
      if (!ids.length) {
        console.error("用法: wocloud unshare <shareId...> [--delete]   （--delete 连记录一起删；默认仅取消）");
        process.exit(1);
      }
      const operType = args.delete ? 2 : 1;
      printResult(await dispatch("CancelOrDelShareFile", {
        shareId: ids.join(","),
        operType,
      }, opts));
      break;
    }
    case "doctor": {
      // 健康检查：凭证 / 网络 / 续期链路 / 容量
      console.log("wocloud doctor — 环境与凭证体检\n");
      console.log(`Node:        ${process.version}${Number(process.version.slice(1)) < 18 ? "  ⚠️ 需要 18+" : "  ✅"}`);
      const creds = loadCredentials();
      const relayCfg = loadRelayConfig();
      console.log(`凭证文件:    ${creds ? `✅ ${CREDS_FILE}（保存于 ${new Date(creds.savedAt).toLocaleString()}）` : "➖ 不存在"}`);
      if (creds && !creds.refreshToken && !relayCfg) console.log("             ⚠️ 缺 refreshToken（token 过期后只能重新扫码）");
      console.log(`relay 托管:  ${relayCfg ? `✅ ${relayCfg.url}（服务器续期，本机只拉取）` : "➖ 未配置（本机自续期）"}`);
      const client = readClientTokens();
      console.log(`客户端缓存:  ${client?.accessToken ? "✅ leveldb 有会话" : "➖ 未检测到客户端登录"}`);
      const s = resolveSession(args.token);
      if (!s) {
        console.log("会话:        ❌ 无可用 token（node wocloud.mjs login 扫码登录）");
        process.exit(1);
      }
      console.log(`会话来源:    ${TOKEN_SOURCE_LABEL[s.source] || s.source}  ${maskToken(s.accessToken)}`);
      // 网络 + 鉴权
      const t0 = Date.now();
      const r = await dispatch("AppQueryUser", { accessToken: opts.token }, { ...opts, profile: "user", autoRefresh: false });
      const ms = Date.now() - t0;
      if (r?.RSP?.RSP_CODE === "0000") {
        console.log(`鉴权:        ✅ whoami 0000（${ms}ms）· ${r.RSP.DATA?.userName}`);
      } else {
        console.log(`鉴权:        ❌ ${r?.RSP?.RSP_CODE} ${r?.RSP?.RSP_DESC}（自动刷新链路将在日常命令里兜底）`);
      }
      // 续期链路：relay 模式下只验证「能否取到最新 token」，绝不在本地抢续期
      if (relayCfg) {
        const pulled = await pullRelayToken(relayCfg);
        console.log(`续期链路:    ${pulled ? "✅ relay 可达（服务器 token-keeper 负责续期）" : "❌ relay 不可达或口令不对——本机不会自行续期"}`);
      } else {
        const fresh = await refreshSession(s);
        console.log(`续期链路:    ${fresh ? `✅ via ${fresh.via}` : "⚠️  exchange 失败——token 彻底失效时需重新 login"}`);
      }
      // 容量
      try {
        const u = await postApi("/api/bff/member/info/card/storage", {}, opts);
        if (u?.result) console.log(`容量:        ✅ ${u.result.space}（${u.result.spaceUsageRatio}）`);
      } catch { console.log("容量:        ⚠️ 查询失败"); }
      break;
    }
    case "post": {
      // 直接向 panservice 发 POST（复刻 background.js 的 post 封装：明文 JSON + X-YP-* 头）
      const p = args._[1];
      if (!p) { console.error("用法: wocloud post <路径> [jsonBody]"); process.exit(1); }
      let body = {};
      if (args._[2]) {
        try { body = JSON.parse(args._[2]); }
        catch { console.error("body 不是合法 JSON"); process.exit(1); }
      }
      const r = await fetch(`${BASE_API}${p}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-YP-Access-Token": opts.token,
          "X-YP-Client-Id": opts.clientId,
          "pc-version": APP_VERSION,
          "pc-os": "mac",
          accessToken: opts.token,
        },
        body: JSON.stringify(body),
      });
      const t = await r.text();
      console.log(`HTTP ${r.status}`);
      try { console.log(JSON.stringify(JSON.parse(t), null, 2)); } catch { console.log(t); }
      break;
    }
    case "raw": {
      const key = args._[1];
      if (!key) { console.error("缺少接口 key"); process.exit(1); }
      let body = {};
      if (args._[2]) { try { body = JSON.parse(args._[2]); } catch { console.error("body 不是合法 JSON"); process.exit(1); } }
      printResult(await dispatch(key, body, opts));
      break;
    }
    default:
      console.error(`未知命令: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }
}

// 直接执行时（含符号链接调用）自动运行；被 shim import 时不运行
function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch { return false; }
}

if (invokedAsMain()) {
  run(process.argv.slice(2)).catch((e) => { console.error("运行失败:", e?.message || e); process.exit(1); });
}

export { run, decodePng, qrModules, renderQr };
