#!/usr/bin/env node
/**
 * tools.mjs — 工具定义与业务实现（与传输层无关）
 *
 * 25 个工具全部在这里：只读查询 / 上传整理 / 破坏性操作 / 文件操作。
 * 传输层（stdio / HTTP）不关心工具怎么实现，只负责把 JSON-RPC 消息送进来。
 *
 * 破坏性工具（rename/mv/rm/restore/purge/empty_trash）在 schema 上要求
 * required:["confirm"]，并在 handler 里二次校验 a.confirm !== true 只返回预演计划。
 * 注意：schema 只约束"遵守协议的客户端"，服务端校验才是真正的闸。
 *
 * 请求级状态（进度回调、已推分片、取消信号）由调用方通过 rt 传入，
 * 不再使用模块级全局——同一个进程要能同时服务多个客户端。
 */

import {
  BASE_API, CLIENT_IDS, DEFAULT_CONCURRENCY, DEFAULT_FILE_CONCURRENCY,
  GLOBAL_MAX_INFLIGHT, MAX_RETRY, DEFAULT_DEVICE_NO,
  dispatch, postApi, resolveToken, fmtSize,
  makeSemaphore, scanLocal, shouldSkipLocal, uploadItems,
  downloadToFile, runPool, callVersionGateway, refreshToken,
} from "./lib/wocloud-core.mjs";
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

export const SERVER_NAME = "wocloud-mcp";
export const SERVER_VERSION = "1.1.0";

function textResult(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}
function errorResult(message) {
  return { content: [{ type: "text", text: `错误: ${message}` }], isError: true };
}

/** 工具结果包装：成功 → textResult；失败 → errorResult */
function toolResult(ok, payload, errMsg) {
  if (ok) return textResult(payload);
  return errorResult(errMsg || payload?.RSP?.RSP_DESC || payload?.meta?.message || "未知错误");
}

// ---------------------------------------------------------------- 工具定义

const READONLY_NOTE = "只读操作，无副作用。";

const TOOLS = [
  {
    name: "wocloud_whoami",
    description: "查询当前登录的联通云盘账号信息（用户名/手机号/会员等级/容量）",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const opts = ctx();
      const res = await dispatch("AppQueryUser", { accessToken: opts.token }, { ...opts, profile: "user" });
      if (rspFail(res)) return { ok: false, ...errorShape(res) };
      return pick(res?.RSP?.DATA, ["nickName", "userName", "mobile", "level", "vipLevel", "space", "usedSpace"]);
    },
  },
  {
    name: "wocloud_usage",
    description: "查询云盘容量使用情况（总容量/已用/占比/知识库）",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const opts = ctx();
      const res = await postApi("/api/bff/member/info/card/storage", {}, opts);
      const r = res?.result;
      if (!r) return { ok: false, ...errorShape(res) };
      return {
        ok: true,
        总容量: r.space, 已用: fmtSize(r.usedSpace), 总计: fmtSize(r.allSpace),
        占比: r.spaceUsageRatio,
        ...(r.knowledgeSpace ? { 知识库: `${fmtSize(r.knowledgeUsedSpace)} / ${fmtSize(r.knowledgeSpace)}` } : {}),
      };
    },
  },
  {
    name: "wocloud_ls",
    description: "列出云盘目录内容。根目录 id 为 \"0\"。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "目录 id，默认 \"0\"（根目录）", default: "0" },
        page: { type: "number", description: "页码，从 0 开始；上一页返回 truncated:true 时翻页获取剩余项", default: 0 },
        pageSize: { type: "number", description: "每页数量 1-1000，默认 100", default: 100 },
      },
    },
    async run(a) {
      const opts = ctx();
      const res = await dispatch("QueryAllFiles", {
        spaceType: "0", parentDirectoryId: a.dir || "0",
        pageNum: Math.max(0, Number(a.page ?? 0)),
        pageSize: Math.min(1000, Math.max(1, Number(a.pageSize ?? 100))),
      }, opts);
      if (rspFail(res)) return { ok: false, ...errorShape(res) };
      const files = res?.RSP?.DATA?.files || [];
      const pageSize = Math.min(1000, Math.max(1, Number(a.pageSize ?? 100)));
      return {
        ok: true,
        dir: a.dir || "0",
        page: Math.max(0, Number(a.page ?? 0)),
        count: files.length,
        truncated: files.length === pageSize,   // 可能还有下一页
        items: files.map((f) => ({
          name: f.name,
          id: f.id,
          fid: f.fid,
          kind: f.type === 0 ? "dir" : "file",
          size: f.type === 0 ? null : Number(f.size) || 0,
          fileVersion: f.fileVersion || undefined,
          mtime: f.modifyTime || undefined,
          shootingTime: f.shootingTime || undefined,   // 照片拍摄时间，整理照片用
        })),
      };
    },
  },
  {
    name: "wocloud_find",
    description: "搜索云盘文件/目录，返回含 fid 的匹配项（供 download 使用）。服务端搜索不可用时自动降级为全盘遍历按文件名匹配。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜索关键字（文件名包含匹配，不区分大小写）" },
        pageSize: { type: "number", description: "最多返回条数，默认 50", default: 50 },
        maxDirs: { type: "number", description: "降级遍历时最多扫描的目录数，默认 200", default: 200 },
      },
      required: ["keyword"],
    },
    async run(a) {
      const opts = ctx();
      const limit = Math.max(1, Number(a.pageSize ?? 50));
      const res = await dispatch("SearchFileV3", {
        searchType: "0", keyWord: a.keyword, pageNo: 1, pageSize: limit,
      }, opts);

      if (!rspFail(res)) {
        const list = res?.RSP?.DATA?.files || res?.RSP?.DATA?.list || [];
        return { ok: true, keyword: a.keyword, source: "server-search", count: list.length, truncated: list.length === limit, items: list.map((f) => ({
          name: f.name, id: f.id, fid: f.fid,
          kind: f.type === 0 ? "dir" : "file", size: Number(f.size) || 0,
        })) };
      }

      // 降级：本地遍历按文件名匹配（服务端 SearchFileV3 网关 504 时的兜底）
      const kw = String(a.keyword || "").toLowerCase();
      if (!kw) return { ok: false, error: "keyword 不能为空" };
      const maxDirs = Math.max(1, Number(a.maxDirs ?? 200));
      const items = [];
      const failures = [];
      let scannedDirs = 0, truncated = false;
      const queue = [["0", 1, ""]];
      while (queue.length && scannedDirs < maxDirs && items.length < limit) {
        const [dirId, depth, path] = queue.shift();
        if (depth > 8) continue;
        const r = await dispatch("QueryAllFiles", {
          spaceType: "0", parentDirectoryId: dirId, pageNum: 0, pageSize: 1000,
        }, opts);
        scannedDirs++;
        if (rspFail(r)) { failures.push(`${path || "/"}: ${errorShape(r).error}`); if (failures.length > 3) break; continue; }
        for (const f of r?.RSP?.DATA?.files || []) {
          const rel = path ? `${path}/${f.name}` : f.name;
          if (f.name.toLowerCase().includes(kw) && items.length < limit) {
            items.push({
              name: f.name, id: f.id, fid: f.fid,
              kind: f.type === 0 ? "dir" : "file", size: Number(f.size) || 0,
              path: rel,
            });
          }
          if (f.type === 0 && depth < 8) queue.push([f.id, depth + 1, rel]);
        }
      }
      if (items.length === limit) truncated = true;
      if (scannedDirs >= maxDirs) truncated = true;
      return {
        ok: failures.length === 0 || items.length > 0,
        keyword: a.keyword, source: "local-walk-fallback",
        serverError: errorShape(res).error,
        scannedDirs, count: items.length, truncated,
        ...(failures.length ? { failures: failures.slice(0, 3) } : {}),
        items,
      };
    },
  },
  {
    name: "wocloud_tree",
    description: "递归盘点目录树，返回各目录/文件占用汇总。千文件目录自动截断并提示 truncated。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "起始目录 id，默认根目录", default: "0" },
        depth: { type: "number", description: "最大递归深度，默认 3（防止过深）", default: 3 },
        maxRows: { type: "number", description: "最多返回的明细行数，默认 500（超出只给汇总）", default: 500 },
      },
    },
    async run(a) {
      const opts = ctx();
      const maxDepth = Math.max(1, Math.min(Number(a.depth ?? 3), 6));
      const maxRows = Math.max(10, Math.min(Number(a.maxRows ?? 500), 5000));
      const rootId = a.dir || "0";
      const rows = [];
      let totalSize = 0, fileCount = 0, dirCount = 0, truncated = false;

      async function walk(dirId, depth) {
        if (depth > maxDepth || truncated) return;
        const res = await dispatch("QueryAllFiles", {
          spaceType: "0", parentDirectoryId: dirId, pageNum: 0, pageSize: 1000,
        }, opts);
        if (rspFail(res)) throw new Error(`列目录 ${dirId} 失败: ${errorShape(res).error}`);
        for (const f of res?.RSP?.DATA?.files || []) {
          const isDir = f.type === 0;
          const size = Number(f.size) || 0;
          if (isDir) dirCount++; else { fileCount++; totalSize += size; }
          if (rows.length < maxRows) {
            rows.push({ depth, name: f.name, kind: isDir ? "dir" : "file", size, id: f.id, fid: f.fid });
          } else {
            truncated = true;   // 超出明细上限：统计继续，明细不再堆积
          }
          if (isDir) await walk(f.id, depth + 1);
        }
      }

      await walk(rootId, 1);
      return { ok: true, root: rootId, dirCount, fileCount, totalSize, totalSizeHuman: fmtSize(totalSize), rows, truncated, ...(truncated ? { note: `明细行数超过上限 ${maxRows}，已截断；统计数字（fileCount/totalSize）仍完整` } : {}) };
    },
  },
  {
    name: "wocloud_path",
    description: "把云盘目录 id 解析为可读路径（面包屑）。逆向自客户端 GetDirectoryPath。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "目录 id，默认 \"0\"（根目录=个人云）", default: "0" },
      },
    },
    async run(a) {
      const opts = ctx();
      const res = await dispatch("GetDirectoryPath", { directoryId: a.dir || "0" }, opts);
      if (rspFail(res)) return { ok: false, ...errorShape(res) };
      const segs = (res?.RSP?.DATA || []).map((s) => s.directoryName || s.name || s.id).reverse();   // 接口返回子→父，反转成自然路径
      return { ok: true, id: a.dir || "0", path: segs.join("/"), segments: segs };
    },
  },
  {
    name: "wocloud_by_type",
    description: "按文件类型浏览（1=图片 2=视频 3=音频 4=文档 5=其它）：不指定目录时查全盘，适合「所有照片」「所有视频」这类盘点。逆向自客户端 QueryTypeFiles。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        fileType: { type: "string", description: "文件类型：1=图片 2=视频 3=音频 4=文档 5=其它", default: "1" },
        dir: { type: "string", description: "限定目录 id；不传则查全盘" },
        page: { type: "number", description: "页码，从 0 开始", default: 0 },
        pageSize: { type: "number", description: "每页数量 1-1000，默认 100", default: 100 },
      },
      required: ["fileType"],
    },
    async run(a) {
      const opts = ctx();
      const pageSize = Math.min(1000, Math.max(1, Number(a.pageSize ?? 100)));
      const params = {
        spaceType: "0",
        fileType: String(a.fileType),
        pageNum: Math.max(0, Number(a.page ?? 0)),
        pageSize,
      };
      if (a.dir) params.directoryId = a.dir;
      const res = await dispatch("QueryTypeFiles", params, opts);
      if (rspFail(res)) return { ok: false, ...errorShape(res) };
      const files = res?.RSP?.DATA?.files || [];
      return {
        ok: true,
        fileType: String(a.fileType),
        scope: a.dir ? `dir:${a.dir}` : "全盘",
        count: files.length,
        truncated: files.length === pageSize,
        items: files.map((f) => ({
          name: f.name,
          id: f.id,
          fid: f.fid,
          size: Number(f.size) || 0,
          fileVersion: f.fileVersion || undefined,
          mtime: f.modifyTime || undefined,
          shootingTime: f.shootingTime || undefined,
        })),
      };
    },
  },
  {
    name: "wocloud_versions",
    description: "查看文件的历史版本列表（抓包实证：fileVersionDispatcher 网关 → /cloud/file-version/file/history/list）。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "文件 id（wcFileId，见 ls 输出）" },
        size: { type: "number", description: "返回条数，默认 10", default: 10 },
      },
      required: ["fileId"],
    },
    async run(a) {
      const opts = ctx();
      const res = await callVersionGateway("/cloud/file-version/file/history/list", {
        size: Math.max(1, Number(a.size ?? 10)),
        wcFileId: a.fileId,
      }, opts);
      if (postFail(res)) return { ok: false, ...errorShape(res) };
      const list = Array.isArray(res?.result) ? res.result : [];
      return {
        ok: true,
        fileId: a.fileId,
        count: list.length,
        items: list.map((v) => ({
          versionId: v.id,
          fileName: v.fileName,
          fileVersion: v.fileVersion,
          size: Number(v.fileSize) || 0,
          updatedTime: v.updatedTime,
          operationType: v.operationType,
          isStatus: v.isStatus,
        })),
      };
    },
  },
  {
    name: "wocloud_sync_units",
    description: "查看本机的同步盘单元列表（抓包实证：fileVersionDispatcher 网关 → /cloud/file-version/sync/unit/list）。只读。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        deviceNo: { type: "string", description: "设备号，默认本机抓包实证值" },
      },
    },
    async run(a) {
      const opts = ctx();
      const res = await callVersionGateway("/cloud/file-version/sync/unit/list", {
        deviceNo: a.deviceNo || DEFAULT_DEVICE_NO,
        current: 0,
        size: 50,
        sortRule: 0,
      }, opts);
      if (postFail(res)) return { ok: false, ...errorShape(res) };
      const records = res?.result?.records || [];
      return {
        ok: true,
        count: records.length,
        items: records.map((u) => ({
          unitId: u.unitId,
          directoryId: u.directoryId,
          directoryName: u.directoryName,
          localSyncLocation: u.localSyncLocation,
          syncStatus: u.syncStatus,
          clientNumber: u.clientNumber,
          createTime: u.createTime,
          deviceNo: u.deviceNo,
        })),
      };
    },
  },
  {
    name: "wocloud_download",
    description: "获取文件下载直链，或直接把文件流式下载到本地路径（需 fid，见 ls/find 输出；不会把大文件读进内存）",
    inputSchema: {
      type: "object",
      properties: {
        fid: { type: "string", description: "文件唯一标识 fid" },
        out: { type: "string", description: "本地输出路径；不传则只返回下载直链" },
        overwrite: { type: "boolean", description: "out 已存在时是否覆盖，默认 false", default: false },
      },
      required: ["fid"],
    },
    async run(a) {
      const opts = ctx();
      const res = await dispatch("GetDownloadUrl", { fidList: [a.fid], spaceType: "0" }, opts);
      if (rspFail(res) || !res?.RSP?.DATA?.[0]?.downloadUrl) return { ok: false, ...errorShape(res) };
      const url = res.RSP.DATA[0].downloadUrl;
      if (!a.out) return { ok: true, url };
      try {
        if (existsSync(a.out) && a.overwrite !== true) {
          const sz = statSync(a.out).size;
          return { ok: false, error: `目标已存在（${fmtSize(sz)}）：${a.out}。确认覆盖请传 overwrite:true` };
        }
        mkdirSync(join(a.out, ".."), { recursive: true });
        const { bytes } = await downloadToFile(url, a.out);
        return { ok: true, out: a.out, bytes };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
  },
];

// ---------------------------------------------------------------- 公共助手

/** 续期成功后缓存的新 token（优先于 leveldb 旧 token） */
let tokenOverride = null;

function ctx() {
  const token = tokenOverride || resolveToken(process.env.WOCLOUD_TOKEN);
  if (!token) {
    throw new Error("未找到 accessToken：请先登录联通云盘 macOS 客户端，或设置环境变量 WOCLOUD_TOKEN");
  }
  return { token, clientId: CLIENT_IDS.mac };
}

/** 结果是否 token 失效类错误（触发自动续期重试；不依赖 isError 标志——{ok:false} 裸结果也认） */
function isTokenError(result) {
  if (!result) return false;
  const text = result.content?.[0]?.text || "";
  return /invalid access-token|20001001|无效的?令牌|令牌.*(无效|过期|失效)|token.*(无效|过期|失效)/i.test(text);
}

function errorShape(res) {
  // 网关错误（非 JSON 响应，如 504）也要暴露，不能被当成"空结果"
  const gateway = res?._httpStatus ? `HTTP ${res._httpStatus}（网关/非 JSON 响应）` : null;
  return {
    error: res?.RSP?.RSP_DESC || res?.meta?.message || gateway || res?._raw || "接口返回异常",
    rspCode: res?.RSP?.RSP_CODE ?? res?.meta?.code ?? res?._httpStatus ?? null,
  };
}

/** dispatcher 系响应是否失败（含网关错误与业务错误码） */
function rspFail(res) {
  if (!res) return true;
  if (res._httpStatus || res._raw) return true;          // 非 JSON 网关响应
  if (res.RSP && res.RSP.RSP_CODE && res.RSP.RSP_CODE !== "0000") return true;
  return false;
}

/** 直连 postApi 系响应是否失败（含网关错误与任务执行结果） */
function postFail(res) {
  if (!res) return true;
  if (res._httpStatus || res._raw) return true;
  if (!(res.meta && String(res.meta.code) === "200")) return true;
  // createTask 响应会同步带任务结果：finish/success 为 false 时任务实际失败
  if (res.result && res.result.success === false) return true;
  return false;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return { ok: true, ...out };
}

/** confirm 未通过时返回预演结果；通过返回 null */
function preview(plan, action) {
  return {
    ok: true,
    preview: true,
    action,
    message: `预演模式：未执行任何${action}操作。确认无误后请带 confirm:true 重新调用本工具。`,
    plan,
  };
}

function buildDeletePayload(fileIds, dirIds, space, deviceNo) {
  const p = {
    taskType: "DELETE",
    sourceSpaceType: space, targetSpaceType: space,
    sourceFileIds: fileIds, sourceDirectoryIds: dirIds,
    targetDirectoryId: "", targetFamilyId: "", sourceFamilyId: "",
    deviceNo: deviceNo || "", clientType: 1,
  };
  if (dirIds.length) p.notEmptyDir = 1;
  return p;
}

// ---------------------------------------------------------------- 上传/整理类

const UPLOAD_TOOLS = [
  {
    name: "wocloud_upload",
    description: "上传本地文件到云盘指定目录（秒传检查 + 16MB 分片并发 + 断点续传），支持多文件",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "本地文件绝对路径列表" },
        dir: { type: "string", description: "目标目录 id，默认 \"0\"", default: "0" },
        concurrency: { type: "number", description: "单文件分片并发数，默认 6", default: 6 },
      },
      required: ["files"],
    },
    async run(a, c) {
      const opts = ctx();
      const missing = a.files.filter((p) => !existsSync(p));
      if (missing.length) return { ok: false, error: `文件不存在: ${missing.join(", ")}` };
      const notFile = a.files.filter((p) => !statSync(p).isFile());
      if (notFile.length) return { ok: false, error: `不是文件: ${notFile.join(", ")}` };
      const sem = makeSemaphore(GLOBAL_MAX_INFLIGHT);
      const log = [];
      const r = await uploadItems(
        a.files.map((p) => ({ path: p, dirId: a.dir || "0" })),
        {
          token: opts.token, sem,
          chunkConc: Math.max(1, Number(a.concurrency ?? DEFAULT_CONCURRENCY)),
          fileConc: DEFAULT_FILE_CONCURRENCY,
          maxRetry: MAX_RETRY,
          shouldAbort: () => c?.aborted?.() === true,
          onLog: (line) => { if (log.length < 200) log.push(line); },
          onProgress: (name, done, total) => {
            const key = name + "|" + total;
            const prev = c.chunkSeen.get(key) || 0;
            if (done > prev) { c.chunkSeen.set(key, done); c.progress(done - prev, `${name} 分片 ${done}/${total}`); }
          },
        },
      );
      c.chunkSeen.clear();
      const failures = r.results.filter((x) => !x.ok && !x.skipped).map((x) => `${basename(x.path)}: ${x.error}`);
      return {
        ok: r.failCount === 0,
        total: r.results.length, uploaded: r.okCount, quickSkipped: r.skipCount, failed: r.failCount,
        totalBytes: r.totalBytes, totalBytesHuman: fmtSize(r.totalBytes), seconds: Math.round(r.seconds * 10) / 10,
        failures,
        log: log.slice(-15),   // 只带回尾部日志，避免大批量上传时结果爆炸
      };
    },
  },
  {
    name: "wocloud_push",
    description: "递归上传整个本地目录到云盘，自动在云端创建相同的目录结构",
    inputSchema: {
      type: "object",
      properties: {
        localDir: { type: "string", description: "本地目录绝对路径" },
        to: { type: "string", description: "云盘目标目录 id，默认 \"0\"", default: "0" },
        concurrency: { type: "number", description: "单文件分片并发数，默认 6", default: 6 },
      },
      required: ["localDir"],
    },
    async run(a, c) {
      const opts = ctx();
      const localDir = a.localDir;
      if (!existsSync(localDir) || !statSync(localDir).isDirectory()) {
        return { ok: false, error: `目录不存在或不是目录: ${localDir}` };
      }
      const targetId = a.to || "0";
      const scanned = scanLocal(localDir);
      if (!scanned.length) return { ok: true, message: "没有可上传的文件（已跳过系统/临时文件）", uploaded: 0 };

      const relDirs = [...new Set(
        scanned.map((f) => f.rel.split("/").slice(0, -1).join("/")),
      )].filter(Boolean).sort((x, y) => x.split("/").length - y.split("/").length);

      const dirMap = new Map([["", targetId]]);
      const createdDirs = [];
      /** 建目录：130007=已存在走查重复用；其余失败 10s/30s/60s 重试；目录间 pacing */
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ensureDir = async (parent, name) => {
        const tryCreate = async () => {
          const res = await dispatch("CreateDirectory", {
            spaceType: "0", parentDirectoryId: parent, directoryName: name,
            deviceNo: "", clientType: 1,
          }, opts);
          if (res?.RSP?.DATA?.id) return { id: res.RSP.DATA.id, existed: false };
          if (res?.RSP?.RSP_CODE === "130007") return { exists: true };   // 已存在：查重复用
          return null;
        };
        let r = await tryCreate();
        if (r) return r;
        for (const wait of [10000, 30000, 60000]) {
          await sleep(wait);
          r = await tryCreate();
          if (r) return r;
        }
        // 查重（重跑/并发场景）
        const q = await dispatch("QueryAllFiles", {
          spaceType: "0", parentDirectoryId: parent, pageNum: 0, pageSize: 1000,
        }, opts);
        const hit = (q?.RSP?.DATA?.files || []).find((f) => f.type === 0 && f.name === name);
        return hit ? { id: hit.id, existed: true } : null;
      };
      for (const rel of relDirs) {
        if (c?.aborted?.()) return { ok: false, error: "已被取消（cancelled）" };
        const parts = rel.split("/");
        const parent = dirMap.get(parts.slice(0, -1).join("/")) ?? targetId;
        const name = parts[parts.length - 1];
        let dir = await ensureDir(parent, name);
        if (dir && dir.exists) {
          const q = await dispatch("QueryAllFiles", {
            spaceType: "0", parentDirectoryId: parent, pageNum: 0, pageSize: 1000,
          }, opts);
          const hit = (q?.RSP?.DATA?.files || []).find((f) => f.type === 0 && f.name === name);
          dir = hit ? { id: hit.id, existed: true } : null;
        }
        if (!dir) return { ok: false, error: `建目录失败: ${rel}（重试与查重均未成功）` };
        dirMap.set(rel, dir.id);
        if (!dir.existed) createdDirs.push({ path: rel, id: dir.id });
        await sleep(1500);                       // 目录间 pacing，降低瞬时故障概率
      }

      // 父目录缺失的文件：跳过并报告（绝不错落到目标根目录）
      const items = [];
      let misplaced = 0;
      for (const f of scanned) {
        const parentRel = f.rel.split("/").slice(0, -1).join("/");
        const dirId = dirMap.get(parentRel);
        if (dirId === undefined) { misplaced++; continue; }
        items.push({ path: f.abs, dirId });
      }
      if (!items.length) return { ok: false, error: "没有可上传的文件（父目录解析失败）" };

      const sem = makeSemaphore(GLOBAL_MAX_INFLIGHT);
      const log = [];
      const r = await uploadItems(
        items,
        {
          token: opts.token, sem,
          chunkConc: Math.max(1, Number(a.concurrency ?? DEFAULT_CONCURRENCY)),
          fileConc: DEFAULT_FILE_CONCURRENCY,
          maxRetry: MAX_RETRY,
          shouldAbort: () => c?.aborted?.() === true,
          onLog: (line) => { if (log.length < 200) log.push(line); },
          onProgress: (name, done, total) => {
            const key = name + "|" + total;
            const prev = c.chunkSeen.get(key) || 0;
            if (done > prev) { c.chunkSeen.set(key, done); c.progress(done - prev, `${name} 分片 ${done}/${total}`); }
          },
        },
      );
      c.chunkSeen.clear();
      const failures = r.results.filter((x) => !x.ok && !x.skipped).map((x) => `${basename(x.path)}: ${x.error}`);
      return {
        ok: r.failCount === 0 && misplaced === 0,
        scanned: scanned.length, createdDirs: createdDirs.length,
        uploaded: r.okCount, quickSkipped: r.skipCount, failed: r.failCount,
        totalBytes: r.totalBytes, totalBytesHuman: fmtSize(r.totalBytes), seconds: Math.round(r.seconds * 10) / 10,
        ...(misplaced ? { misplaced, note: `${misplaced} 个文件因父目录解析失败被跳过（未错传）` } : {}),
        failures,
        log: log.slice(-15),
      };
    },
  },
  {
    name: "wocloud_mirror",
    description: "把云盘目录树镜像（增量）下载到本地：本地已存在且大小一致则跳过；并行 4 路流式下载",
    inputSchema: {
      type: "object",
      properties: {
        remoteDir: { type: "string", description: "云盘目录 id，默认 \"0\"", default: "0" },
        localPath: { type: "string", description: "本地目标目录（绝对路径）" },
        dryRun: { type: "boolean", description: "只罗列将下载的文件，不实际写入", default: false },
        concurrency: { type: "number", description: "并发下载数，默认 4", default: 4 },
      },
      required: ["localPath"],
    },
    async run(a, c) {
      const opts = ctx();
      const remoteId = a.remoteDir || "0";
      const localRoot = a.localPath;
      const dryRun = !!a.dryRun;
      const conc = Math.max(1, Math.min(Number(a.concurrency ?? 4), 8));
      const shouldAbort = () => c?.aborted?.() === true;

      // 第一遍：收集需要下载的文件清单
      const todo = [];
      let skipped = 0;
      const failures = [];
      async function collect(dirId, localPath) {
        if (shouldAbort()) throw new Error("已被取消（cancelled）");
        mkdirSync(localPath, { recursive: true });
        const res = await dispatch("QueryAllFiles", {
          spaceType: "0", parentDirectoryId: dirId, pageNum: 0, pageSize: 1000,
        }, opts);
        if (rspFail(res)) throw new Error(`列目录 ${dirId} 失败: ${errorShape(res).error}`);
        for (const f of res?.RSP?.DATA?.files || []) {
          const target = join(localPath, safeName(f.name));
          if (f.type === 0) { await collect(f.id, target); continue; }
          const size = Number(f.size) || 0;
          if (existsSync(target)) {
            try { if (statSync(target).size === size) { skipped++; continue; } } catch { /* 继续下载 */ }
          }
          todo.push({ fid: f.fid, name: f.name, target, size });
        }
      }
      await collect(remoteId, localRoot);
      if (shouldAbort()) return { ok: false, error: "已被取消（cancelled）" };

      if (dryRun) {
        return { ok: true, dryRun: true, wouldDownload: todo.length,
          bytes: todo.reduce((s, t) => s + t.size, 0),
          bytesHuman: fmtSize(todo.reduce((s, t) => s + t.size, 0)),
          files: todo.slice(0, 50).map((t) => ({ path: t.target, size: t.size })),
          ...(todo.length > 50 ? { note: `仅展示前 50 个，共 ${todo.length} 个` } : {}) };
      }

      // 第二遍：并行流式下载
      let done = 0, bytes = 0;
      await runPool(todo, conc, async (item) => {
        if (shouldAbort()) { failures.push(`${item.target}: 已取消`); return; }
        try {
          const r = await dispatch("GetDownloadUrl", { fidList: [item.fid], spaceType: "0" }, opts);
          const url = r?.RSP?.DATA?.[0]?.downloadUrl;
          if (!url) throw new Error("未取到下载地址");
          await downloadToFile(url, item.target);
          done++; bytes += item.size;
          c.progress(1, item.name);
        } catch (e) {
          failures.push(`${item.target}: ${e?.message || e}`);
        }
      });

      return { ok: failures.length === 0, done, skipped, failed: failures.length, bytes, bytesHuman: fmtSize(bytes), failures: failures.slice(0, 20) };
    },
  },
  {
    name: "wocloud_mkdir",
    description: "在云盘创建目录",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "新目录名称" },
        dir: { type: "string", description: "父目录 id，默认 \"0\"", default: "0" },
      },
      required: ["name"],
    },
    async run(a) {
      const opts = ctx();
      const res = await dispatch("CreateDirectory", {
        spaceType: "0", parentDirectoryId: a.dir || "0",
        directoryName: a.name, deviceNo: "", clientType: 1,
      }, opts);
      if (res?.RSP?.RSP_CODE && res.RSP.RSP_CODE !== "0000") return { ok: false, ...errorShape(res) };
      return { ok: true, id: res?.RSP?.DATA?.id, parent: a.dir || "0", name: a.name };
    },
  },
];

/** 清理文件名中的非法字符，避免写出越界路径 */
function safeName(name) {
  return String(name)
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 200);
}

// ---------------------------------------------------------------- 破坏性工具
// 设计原则：schema 强制 required:["confirm"]；confirm !== true 时只返回预演计划。

const DESTRUCTIVE_TOOLS = [
  {
    name: "wocloud_batch_rename",
    description: "批量重命名文件/目录（抓包实证：POST /wohome/open/file/batchRename，前缀/后缀/序号规则；异步任务带 taskId）。破坏性，confirm 必须显式为 true",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "要重命名的文件/目录 id 列表" },
        types: { type: "array", items: { type: "number" }, description: "与 ids 对应的类型：1=文件 0=目录" },
        parentId: { type: "string", description: "父目录 id" },
        prefix: { type: "string", description: "名称前缀，可空", default: "" },
        suffix: { type: "string", description: "名称后缀，可空", default: "" },
        indexEnabled: { type: "boolean", description: "是否加序号", default: false },
        indexPosition: { type: "string", enum: ["afterSuffix", "beforePrefix"], description: "序号位置", default: "afterSuffix" },
        indexDigits: { type: "number", description: "序号位数", default: 3 },
        indexStart: { type: "number", description: "序号起始值", default: 0 },
        deviceNo: { type: "string", description: "设备号，默认本机抓包实证值" },
        confirm: { type: "boolean", description: "必须为 true 才会真正执行批量重命名" },
      },
      required: ["ids", "types", "parentId", "confirm"],
    },
    async run(a) {
      const plan = {
        sourceIds: a.ids,
        types: a.types,
        parentId: a.parentId,
        deviceNo: a.deviceNo || DEFAULT_DEVICE_NO,
        clientType: 0,
        spaceType: "0",
        renameRule: {
          prefix: a.prefix || "",
          suffix: a.suffix || "",
          index: {
            enabled: !!a.indexEnabled,
            position: a.indexPosition || "afterSuffix",
            digits: Number(a.indexDigits ?? 3),
            start: Number(a.indexStart ?? 0),
          },
        },
      };
      if (a.confirm !== true) return preview(plan, "批量重命名");
      const opts = ctx();
      const res = await postApi("/wohome/open/file/batchRename", plan, opts);
      if (postFail(res)) return { ok: false, ...errorShape(res) };
      const taskId = res?.result?.taskId;
      return { ok: true, taskId, message: taskId ? `批量重命名任务已提交（taskId=${taskId}），完成后可用 wocloud_ls 核对结果` : "已提交" };
    },
  },
  {
    name: "wocloud_rename",
    description: "重命名云盘文件或目录（破坏性，confirm 必须显式为 true 才执行）",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "文件/目录 id（见 ls 输出）" },
        newName: { type: "string", description: "新名称" },
        isDir: { type: "boolean", description: "目标是否为目录", default: false },
        version: { type: "number", description: "文件版本号，默认 1（文件必填语义同 CLI）", default: 1 },
        confirm: { type: "boolean", description: "必须为 true 才会真正执行重命名；false/缺失时只返回预演" },
      },
      required: ["id", "newName", "confirm"],
    },
    async run(a) {
      const plan = {
        spaceType: "0",
        type: a.isDir ? 0 : 1,
        id: a.id,
        name: a.newName,
        deviceNo: "",
        clientType: 1,
        ...(a.isDir ? {} : { fileVersion: Number(a.version ?? 1) }),
      };
      if (a.confirm !== true) return preview(plan, "重命名");
      const opts = ctx();
      const res = await dispatch("RenameFileOrDirectory", plan, opts);
      return toolResult(!rspFail(res), res);
    },
  },
  {
    name: "wocloud_mv",
    description: "移动云盘文件/目录到另一个目录（破坏性，confirm 必须显式为 true 才执行）",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "要移动的文件/目录 id 列表" },
        to: { type: "string", description: "目标目录 id（根目录为 \"0\"）" },
        isDir: { type: "boolean", description: "目标是否为目录", default: false },
        version: { type: "number", description: "文件版本号，默认 1", default: 1 },
        confirm: { type: "boolean", description: "必须为 true 才会真正执行移动" },
      },
      required: ["ids", "to", "confirm"],
    },
    async run(a) {
      const isDir = !!a.isDir;
      const payload = {
        taskType: "MOVE",
        sourceSpaceType: "0", targetSpaceType: "0",
        sourceFileIds: isDir ? [] : a.ids,
        sourceDirectoryIds: isDir ? a.ids : [],
        targetDirectoryId: a.to,
        targetFamilyId: "", sourceFamilyId: "",
        deviceNo: "", clientType: 1,
      };
      if (isDir) payload.notEmptyDir = 0;
      else payload.fileVersion = Number(a.version ?? 1);
      if (a.confirm !== true) return preview(payload, "移动");
      const opts = ctx();
      const res = await postApi("/wohome/pass/file/batch/createTask", payload, opts);
      return toolResult(!postFail(res), res);
    },
  },
  {
    name: "wocloud_rm",
    description: "删除云盘文件或目录（放入回收站；破坏性，confirm 必须显式为 true 才执行）。递归删目录需 recursive:true",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "要删除的文件/目录 id 列表" },
        isDir: { type: "boolean", description: "目标是否为目录", default: false },
        recursive: { type: "boolean", description: "目录非空时递归删除内部文件与子目录", default: false },
        confirm: { type: "boolean", description: "必须为 true 才会真正执行删除" },
      },
      required: ["ids", "confirm"],
    },
    async run(a) {
      const opts0 = ctx();
      const isDir = !!a.isDir;
      const plan = [];

      if (isDir && a.recursive) {
        // 递归收集目录内的文件与子目录（子目录按深度倒序，先删深层）
        for (const id of a.ids) {
          const fileIds = [];
          const dirs = [];
          const queue = [[id, 0]];
          while (queue.length) {
            const [cur, depth] = queue.shift();
            const res = await dispatch("QueryAllFiles", {
              spaceType: "0", parentDirectoryId: cur, pageNum: 0, pageSize: 1000,
            }, opts0);
            if (rspFail(res)) return { ok: false, error: `递归收集失败（${cur}）: ${errorShape(res).error}` };
            for (const f of res?.RSP?.DATA?.files || []) {
              if (f.type === 0) queue.push([f.id, depth + 1]);
              else fileIds.push(f.id);
            }
            dirs.push({ id: cur, depth: cur === id ? -1 : depth });
          }
          dirs.sort((x, y) => y.depth - x.depth);
          if (fileIds.length) plan.push(buildDeletePayload(fileIds, [], "0", ""));
          for (const d of dirs) plan.push(buildDeletePayload([], [d.id], "0", ""));
        }
      } else if (isDir) {
        // 非递归：服务端拒绝删除非空目录（错误码 5056），先检查
        const res = await dispatch("QueryAllFiles", {
          spaceType: "0", parentDirectoryId: a.ids[0], pageNum: 0, pageSize: 1000,
        }, opts0);
        const n = (res?.RSP?.DATA?.files || []).length;
        if (n > 0 && a.ids.length === 1) {
          return { ok: false, error: `目录下还有 ${n} 项，服务端拒绝删除非空目录（错误码 5056）。如需连同内容一起删除，请加 recursive:true` };
        }
        plan.push(buildDeletePayload([], a.ids, "0", ""));
      } else {
        plan.push(buildDeletePayload(a.ids, [], "0", ""));
      }

      if (a.confirm !== true) return preview(plan, "删除");
      let failed = 0;
      const details = [];
      for (const p of plan) {
        const res = await postApi("/wohome/pass/file/batch/createTask", p, opts0);
        if (postFail(res)) { failed++; details.push({ code: res?.meta?.code ?? res?._httpStatus, message: res?.meta?.message ?? errorShape(res).error }); }
      }
      return { ok: failed === 0, batches: plan.length, failed, ...(details.length ? { details } : {}) };
    },
  },
  {
    name: "wocloud_trash",
    description: "查看回收站列表（含 deleteNo，供 restore/purge 使用）。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "返回条数，默认 100", default: 100 },
      },
    },
    async run(a) {
      const opts = ctx();
      const res = await dispatch("QueryRecycleData", {
        spaceType: "0", pageNum: 0, pageSize: Number(a.limit ?? 100),
      }, opts);
      const list = res?.RSP?.DATA;
      if (!Array.isArray(list)) return toolResult(false, res);
      return {
        ok: true,
        count: list.length,
        items: list.map((it) => ({
          name: it.name,
          deleteNo: it.deleteNo,
          kind: it.type === "0" ? "dir" : "file",
          size: Number(it.fileSize) || 0,
          deleteTime: it.deleteTime,
          keepDays: it.keepDays,
        })),
      };
    },
  },
  {
    name: "wocloud_restore",
    description: "从回收站还原文件/目录（需 deleteNo，见 wocloud_trash）",
    inputSchema: {
      type: "object",
      properties: {
        deleteNos: { type: "array", items: { type: "string" }, description: "回收站条目的 deleteNo 列表" },
        confirm: { type: "boolean", description: "必须为 true 才会真正执行还原" },
      },
      required: ["deleteNos", "confirm"],
    },
    async run(a) {
      const plan = { spaceType: "0", deleteNos: a.deleteNos };
      if (a.confirm !== true) return preview(plan, "还原");
      const opts = ctx();
      const res = await dispatch("ReductionRecycleData", plan, opts);
      return toolResult(!rspFail(res), res);
    },
  },
  {
    name: "wocloud_purge",
    description: "彻底删除回收站条目（不可恢复！confirm 必须显式为 true 才执行）",
    inputSchema: {
      type: "object",
      properties: {
        deleteNos: { type: "array", items: { type: "string" }, description: "要彻底删除的 deleteNo 列表" },
        confirm: { type: "boolean", description: "必须为 true 才会真正彻底删除（不可恢复）" },
      },
      required: ["deleteNos", "confirm"],
    },
    async run(a) {
      const plan = { spaceType: "0", deleteNos: a.deleteNos };
      if (a.confirm !== true) return preview(plan, "彻底删除");
      const opts = ctx();
      const res = await dispatch("DeleteRecycleData", plan, opts);
      return toolResult(!rspFail(res), res);
    },
  },
  {
    name: "wocloud_empty_trash",
    description: "清空整个回收站（不可恢复！confirm 必须显式为 true 才执行）",
    inputSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", description: "必须为 true 才会真正清空回收站（不可恢复）" },
      },
      required: ["confirm"],
    },
    async run(a) {
      const plan = { spaceType: "0" };
      if (a.confirm !== true) {
        // 预演时先把回收站现状带回来，让调用方看清将毁掉什么
        const opts = ctx();
        const res = await dispatch("QueryRecycleData", { spaceType: "0", pageNum: 0, pageSize: 50 }, opts);
        const list = Array.isArray(res?.RSP?.DATA) ? res.RSP.DATA : [];
        const totalSize = list.reduce((s, it) => s + (Number(it.fileSize) || 0), 0);
        return {
          ...preview(plan, "清空回收站"),
          trashCount: list.length,
          trashSize: fmtSize(totalSize),
          sample: list.slice(0, 10).map((it) => `${it.type === "0" ? "📁" : "📄"} ${it.name}（${fmtSize(Number(it.fileSize) || 0)}，剩余 ${it.keepDays} 天自动清除）`),
        };
      }
      const opts = ctx();
      const res = await dispatch("EmptyRecycleData", plan, opts);
      return toolResult(!rspFail(res), res);
    },
  },
];

// ---------------------------------------------------------------- 文件操作（非破坏性）

const FILE_OP_TOOLS = [
  {
    name: "wocloud_favorite",
    description: "收藏/取消收藏云盘文件或目录（抓包实证参数：fileList+dirList+operateStatus 1=收藏 0=取消）",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "文件 id 列表" },
        dirIds: { type: "array", items: { type: "string" }, description: "目录 id 列表（与 ids 二选一或同用）" },
        action: { type: "string", enum: ["add", "cancel"], description: "add=收藏，cancel=取消收藏", default: "add" },
      },
      required: ["action"],
    },
    async run(a) {
      const opts = ctx();
      const payload = {
        dirList: a.dirIds || [],
        fileList: a.ids || [],
        operateStatus: a.action === "cancel" ? 0 : 1,
        spaceType: "0",
      };
      if (!payload.fileList.length && !payload.dirList.length) {
        return { ok: false, error: "ids 和 dirIds 至少要给一个" };
      }
      const res = await postApi("/wocloud/favorite/addAndCancelFavorite", payload, opts);
      return toolResult(!postFail(res), res);
    },
  },
  {
    name: "wocloud_favorite_list",
    description: "查看收藏列表（抓包实证参数：{spaceType, page, pageSize}）。" + READONLY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "页码，从 0 开始", default: 0 },
        pageSize: { type: "number", description: "每页数量，默认 50", default: 50 },
      },
    },
    async run(a) {
      const opts = ctx();
      const res = await postApi("/wocloud/favorite/list", {
        spaceType: "0",
        page: Math.max(0, Number(a.page ?? 0)),
        pageSize: Math.max(1, Number(a.pageSize ?? 50)),
      }, opts);
      if (postFail(res)) return { ok: false, ...errorShape(res) };
      const list = res?.result?.fileAndDirList || [];
      return {
        ok: true,
        count: list.length,
        items: list.map((f) => ({
          name: f.name || f.fileName,
          id: f.id || f.wcFileId,
          kind: f.type === 0 || f.type === "0" ? "dir" : "file",
          collectTime: f.collectTime,
        })),
      };
    },
  },
  {
    name: "wocloud_copy",
    description: "复制云盘文件/目录到另一个目录（非破坏性：只新增副本，不删源。逆向自客户端 taskType:\"COPY\"）",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "要复制的文件/目录 id 列表" },
        to: { type: "string", description: "目标目录 id（根目录为 \"0\"）" },
        isDir: { type: "boolean", description: "目标是否为目录", default: false },
      },
      required: ["ids", "to"],
    },
    async run(a) {
      const isDir = !!a.isDir;
      // 载荷复刻客户端 copy 提交（chunk 实证）：无 fileVersion，目录带 notEmptyDir:0
      const payload = {
        taskType: "COPY",
        sourceSpaceType: "0", targetSpaceType: "0",
        sourceFileIds: isDir ? [] : a.ids,
        sourceDirectoryIds: isDir ? a.ids : [],
        targetDirectoryId: a.to,
        targetFamilyId: "", sourceFamilyId: "",
        deviceNo: "", clientType: 1,
      };
      if (isDir) payload.notEmptyDir = 0;
      const opts = ctx();
      const res = await postApi("/wohome/pass/file/batch/createTask", payload, opts);
      return toolResult(!postFail(res), res);
    },
  },
];

// ---------------------------------------------------------------- 注册与分发

const ALL_TOOLS = [...TOOLS, ...UPLOAD_TOOLS, ...DESTRUCTIVE_TOOLS, ...FILE_OP_TOOLS];
const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

async function callTool(name, args, rt = {}) {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new Error(`未知工具: ${name}`);
  return await tool.run(args || {}, rt);
}

// ---------------------------------------------------------------- 导出

export { ALL_TOOLS, TOOL_MAP, callTool, isTokenError, textResult, errorResult, toolResult };

/**
 * 续期成功后的新 token 覆盖（单用户设计：一个进程 = 一个联通云盘账号）。
 * 多账号部署需要把这里换成按请求身份解析，见 README「设计边界」。
 */
export function setTokenOverride(token) {
  tokenOverride = token;
}
