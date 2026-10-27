#!/usr/bin/env node
/**
 * wocloud-bulk — 联通云盘「批量备份 / 迁移」工具 v2
 *
 * 为什么存在：`wocloud-cli push` 有三个缺陷（建目录限流静默降级、mv 大批次 500、
 * 失败无告警），本工具把它们全部内置为防护：
 *   1) 建目录与传文件分离，建目录 1.8s 节流（实测 0 失败）
 *   2) mv 自动拆成单文件循环（服务端一次只能 MOVE 1 个，>=2 返回 500）
 *   3) 所有操作结构化校验响应，失败进 failures.json，--resume 只重跑失败项
 *
 * 用法:
 *   node tools/wocloud-bulk.mjs backup <本地目录> <云端目录id> [--label 名] [--dry-run] [--resume failures.json]
 *   node tools/wocloud-bulk.mjs verify <本地目录> <云端目录id>
 *   node tools/wocloud-bulk.mjs clean  <本地目录> <云端目录id> [--yes]
 *
 * 依赖: Node 18+（零 npm 依赖）
 * 长任务请用 caffeinate -is 包裹，否则系统睡眠 = 全部 fetch failed。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "wocloud-cli.mjs");
const THROTTLE_MS = 1800;      // 建目录节流（服务端限流阈值实测 ~1.5s）
const MV_THROTTLE_MS = 1200;   // mv 间隔
const UPLOAD_BATCH = 30;
const CLI_TIMEOUT_MS = 600_000; // 单次调用 10 分钟硬超时，防挂起拖死任务
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"]);
const BAD_SUFFIX = [".key", ".pem", ".p12", ".pfx"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 运行状态落盘 ----------
/**
 * state 语义(唯一事实源,勿破坏):
 *   <label>-state.json.uploaded = 该 label 累计已成功上传的文件相对路径清单,只增不减,跨运行延续。
 *   fresh / --resume(只重跑失败) / --continue(跳过已传) 三种进入路径都只是对本次 files 的过滤,
 *   落盘时必须合并历史 uploaded,否则一次 resume 会把全量重传的口子撕开(2026-10-25 踩过)。
 */
function statePath(label) { return `${label}-state.json`; }
function saveState(st) {
  st.updatedAt = new Date().toISOString();
  const f = statePath(st.label), tmp = `${f}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(st)); renameSync(tmp, f); } catch { /* 状态落盘失败不影响主流程 */ }
}
function loadState(label) {
  const f = statePath(label);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

/** 云端路径 → 目录 id("工作区/项目-win/06-projects"),缺失的段自动创建 */
async function resolveCloudPath(pathStr) {
  let id = "0";
  for (const seg of pathStr.split("/").filter(Boolean)) {
    const hit = qAll(id).find((f) => f.type === 0 && f.name === seg);
    if (hit) { id = hit.id; continue; }
    const made = createDir(id, seg);
    if (!made) throw new Error(`云端路径无法创建: ${pathStr}（卡在「${seg}」，多为其父目录限流）`);
    id = made.id;
    await sleep(THROTTLE_MS);
  }
  return id;
}

function cli(...args) {
  return execFileSync("node", [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: CLI_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
}

/**
 * 结构化解析 CLI 响应 —— 静默失败的根治手段。
 * CLI 有三种输出形态：dispatcher 的 {RSP:{RSP_CODE}}、直连的 {meta:{code}}、HTTP 错误的 {_httpStatus}。
 */
function parseRsp(out) {
  const t = (out ?? "").trim();
  if (!t) return { ok: false, code: "EMPTY", desc: "无输出" };
  try {
    const j = JSON.parse(t);
    if (j.RSP) {
      const code = String(j.RSP.RSP_CODE ?? "");
      return { ok: code === "0000", code, desc: j.RSP.RSP_DESC ?? "", data: j.RSP.DATA ?? null };
    }
    if (j.meta) {
      const code = String(j.meta.code ?? "");
      return { ok: code === "200" || code === "0", code, desc: j.meta.message ?? "", data: j.result ?? null };
    }
    if (j._httpStatus) return { ok: false, code: String(j._httpStatus), desc: "HTTP 网关错误", data: null };
  } catch { /* 非 JSON，走特征匹配 */ }
  if (t.includes("internal server error") || t.includes('"code": "500"'))
    return { ok: false, code: "500", desc: "服务端 500" };
  if (t.includes("504") || t.includes("Gateway Time-out"))
    return { ok: false, code: "504", desc: "网关超时" };
  if (t.includes("fetch failed") || t.includes("aborted due to timeout"))
    return { ok: false, code: "NETWORK", desc: "网络错误/超时" };
  return { ok: false, code: "UNPARSED", desc: t.slice(0, 120) };
}

function qAll(dirId) {
  const out = cli("raw", "QueryAllFiles", JSON.stringify({
    spaceType: "0", parentDirectoryId: dirId, pageNum: 0, pageSize: 1000,
  }));
  const r = parseRsp(out);
  if (!r.ok) throw new Error(`QueryAllFiles ${r.code} ${r.desc}`);
  return r.data?.files ?? [];
}

function remoteDirs(rootId) {
  const out = {};
  const walk = (id, prefix) => {
    for (const f of qAll(id)) {
      if (f.type !== 0) continue;
      const rel = prefix ? `${prefix}/${f.name}` : f.name;
      out[rel] = f.id;
      walk(f.id, rel);
    }
  };
  walk(rootId, "");
  return out;
}

function isBad(name) {
  const n = name.toLowerCase();
  if (n.startsWith(".env")) return true;
  if (BAD_SUFFIX.some((s) => n.endsWith(s))) return true;
  if (n.startsWith("id_rsa")) return true;
  if (n.includes("credential") || n.includes(".secret")) return true;
  return false;
}

function scanLocal(base) {
  const hasGit = existsSync(join(base, ".git"));
  let rels = [];
  if (hasGit) {
    const buf = execFileSync("git", ["ls-files", "-z"], { cwd: base, maxBuffer: 128 * 1024 * 1024 });
    rels = buf.toString("utf8").split("\0").filter(Boolean);
  } else {
    const walk = (dir, prefix) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
        } else if (e.isFile()) {
          if (SKIP_DIRS.has(e.name)) continue;
          rels.push(prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
    };
    walk(base, "");
  }
  return rels.filter((r) => !isBad(r.split("/").pop()));
}

function createDir(parentId, name) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = parseRsp(cli("raw", "CreateDirectory", JSON.stringify({
        spaceType: "0", parentDirectoryId: parentId,
        directoryName: name, deviceNo: "", clientType: 1,
      })));
      if (r.data?.id) return { id: r.data.id, created: r.code === "0000" };
    } catch { /* 超时/网络，重试 */ }
    execFileSync("sleep", [String(1.5 * (a + 1))]);
  }
  return null;
}

async function ensureDirs(base, rootId, dmap, label, failures, st) {
  const need = [];
  (function walk(dir, prefix) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!(rel in dmap)) need.push(rel);
      walk(join(dir, e.name), rel);
    }
  })(base, "");
  need.sort((a, b) => a.split("/").length - b.split("/").length);
  console.log(`  云端已有 ${Object.keys(dmap).length} 目录，缺 ${need.length} 个`);
  st.phase = "mkdir";
  st.mkdir = { have: Object.keys(dmap).length, need: need.length, done: 0 };
  saveState(st);
  let ok = 0, created = 0;
  for (const rel of need) {
    const parts = rel.split("/");
    const pid = parts.length === 1 ? rootId : dmap[parts.slice(0, -1).join("/")];
    if (!pid) { failures.push({ op: "mkdir", target: rel, error: "父目录缺失", kind: "failed" }); continue; }
    const r = createDir(pid, parts[parts.length - 1]);
    if (r) {
      dmap[rel] = r.id; ok++;
      if (r.created) { created++; await sleep(THROTTLE_MS); }   // 真新建才节流
      else await sleep(150);                                     // 已存在(130007)快速通过
    } else {
      failures.push({ op: "mkdir", target: rel, error: "重试 3 次仍失败", kind: "failed" });
      console.log(`  ✗ ${rel}`);
    }
    st.mkdir.done++;
    if (st.mkdir.done % 25 === 0 || st.mkdir.done === need.length) {
      const el = (Date.now() - st.t0) / 1000;
      const rate = st.mkdir.done / Math.max(el, 1);
      console.log(`  目录 ${st.mkdir.done}/${need.length} · ${rate.toFixed(1)}/s · ETA ${Math.round((need.length - st.mkdir.done) / Math.max(rate, 0.01))}s · 失败 ${st.mkdir.done - ok}`);
      saveState(st);
    }
  }
  console.log(`  ${label} 目录: 补齐 ${ok}（新建 ${created}）/ 失败 ${need.length - ok}`);
}

/** mv 单文件 + 500/504 自动重试（服务端一次只能 MOVE 1 个，>=2 必 500） */
async function mvOne(id, to, version, failures) {
  for (let a = 0; a < 3; a++) {
    let r;
    try {
      r = parseRsp(cli("mv", id, "--to", to, "--version", String(version), "--yes"));
    } catch (e) {
      r = { ok: false, code: "CLI-TIMEOUT", desc: String(e.message).slice(0, 80) };
    }
    if (r.ok) return true;
    if (["500", "504", "NETWORK", "CLI-TIMEOUT", "EMPTY"].includes(r.code)) {
      await sleep(1500 * (a + 1));   // 可重试错误：指数退避
      continue;
    }
    failures.push({ op: "mv", target: id, error: `${r.code} ${r.desc}` });
    return false;
  }
  failures.push({ op: "mv", target: id, error: "500/504 重试 3 次仍失败" });
  return false;
}

/** 从 CLI 输出中取 upload --json 的结构化结果（取最后一条可解析且含 okCount 的 JSON 行） */
function parseUploadJson(out) {
  for (const line of String(out).trim().split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t);
      if (typeof j.okCount === "number") return j;
    } catch { /* 非 JSON 行,跳过 */ }
  }
  return null;
}

let progressLine = "";
function progress(done, total, t0, failed, prefix) {
  const el = (Date.now() - t0) / 1000;
  const rate = done / Math.max(el, 1);
  const eta = Math.round((total - done) / Math.max(rate, 0.01));
  const line = `  ${prefix} ${done}/${total} · ${rate.toFixed(1)}op/s · ETA ${eta}s · 失败 ${failed}`;
  if (line !== progressLine) { progressLine = line; console.log(line); }
}

async function cmdBackup([base, rawTarget], opts, failures) {
  const label = opts.label ?? "备份";
  console.log(`=== ${label} ===`);
  console.log(`  本地: ${base}`);
  console.log(`  💡 长任务建议: caffeinate -is node tools/wocloud-bulk.mjs ... （防睡眠断网）`);

  // 目标兼容 32 位目录 id 与云端路径（"工作区/项目-win/xx"，缺失段自动创建）
  const rootId = /^[0-9a-f]{32}$/i.test(rawTarget) ? rawTarget : await resolveCloudPath(rawTarget);
  if (rootId !== rawTarget) console.log(`  云端目标: ${rawTarget} → ${rootId}`);

  let files = scanLocal(base);
  console.log(`  待备份文件 ${files.length} 个（已排除 .git/node_modules/凭证）`);

  // --resume：只处理上次失败清单里的文件（兼容旧数组格式与新 {failed,skipped} 格式）
  if (opts.resume) {
    const prev = JSON.parse(readFileSync(opts.resume, "utf8"));
    const arr = Array.isArray(prev) ? prev : [...(prev.failed ?? []), ...(prev.skipped ?? [])];
    const want = new Set(arr.filter((f) => f.op === "upload").map((f) => f.file));
    files = files.filter((f) => want.has(f));
    console.log(`  [resume] 上次失败 ${want.size} 个，本次只处理这些`);
  }

  const st = {
    label, base, target: rootId, phase: "scan", t0: Date.now(),
    total: files.length, done: 0, failed: 0,
    uploaded: [],
    startedAt: new Date().toISOString(),
  };

  // 状态延续：历史已传清单要在本次落盘时保留（否则 --resume 跑完会覆盖掉原 state，
  // 之后一次 --continue 会把之前传过的文件全部重传）
  const prevState = loadState(label);
  const doneSet = new Set(prevState?.uploaded ?? []);
  st.uploaded = [...doneSet];

  // --continue：从状态文件续传（跳过已成功上传的文件；断点续传的主体）
  if (opts.continue) {
    if (doneSet.size) {
      files = files.filter((f) => !doneSet.has(f));
      console.log(`  [continue] 状态文件已有 ${doneSet.size} 个已传记录，本次跳过`);
    } else {
      console.log("  [continue] 未找到可续传的状态，从头开始");
    }
  }
  st.total = files.length;

  // 0 字节预过滤（云盘 400，浪费请求）——属预期跳过，与真失败分开记
  const zero = files.filter((f) => statSync(join(base, f)).size === 0);
  if (zero.length) {
    console.log(`  ⚠️ 跳过 ${zero.length} 个 0 字节文件（云盘不收空文件）`);
    for (const z of zero) failures.push({ op: "upload", file: z, error: "0 字节文件，云盘不支持", kind: "skipped" });
    files = files.filter((f) => statSync(join(base, f)).size > 0);
  }

  if (opts["dry-run"]) { console.log("  [dry-run] 仅扫描，未做任何变更"); return; }

  const dmap = remoteDirs(rootId);
  await ensureDirs(base, rootId, dmap, label, failures, st);

  st.phase = "upload";
  saveState(st);

  const groups = new Map();
  let skipped = 0;
  for (const rel of files) {
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const did = parent ? dmap[parent] : rootId;
    if (!did) { skipped++; failures.push({ op: "upload", file: rel, error: "云端目录缺失", kind: "failed" }); continue; }
    if (!groups.has(did)) groups.set(did, []);
    groups.get(did).push(join(base, rel));
  }
  if (skipped) console.log(`  ⚠️ 云端缺目录，跳过 ${skipped} 个文件（已记入失败清单）`);

  let done = 0, failed = 0;
  const t0 = Date.now();
  for (const [did, list] of groups) {
    for (let i = 0; i < list.length; i += UPLOAD_BATCH) {
      const batch = list.slice(i, i + UPLOAD_BATCH);
      let out = "";
      try {
        out = cli("upload", ...batch, "--dir", did, "--json");
      } catch (e) {
        out = String(e.stdout ?? "") || `fetch failed ${String(e.message).slice(0, 60)}`;
      }
      const j = parseUploadJson(out);
      if (j && j.ok === false && Array.isArray(j.results) && j.results.some((x) => x.ok || x.skipped)) {
        // 结构化部分失败:精确到文件记账
        for (const x of j.results) {
          const rel = relative(base, x.file).split(sep).join("/");
          if (x.ok || x.skipped) { done++; st.uploaded.push(rel); }
          else { failed++; failures.push({ op: "upload", file: rel, error: x.error ?? "upload failed", kind: "failed" }); }
        }
        st.done = done; st.failed = failed;
        saveState(st);
        console.log(`  ⚠️ 批次部分失败 ${j.failCount}/${batch.length} — 已逐文件记入失败清单`);
      } else if (j ? j.ok : (out.includes("上传完成") || out.includes("秒传"))) {
        done += batch.length;
        for (const p of batch) st.uploaded.push(relative(base, p).split(sep).join("/"));
        st.done = done; st.failed = failed;
        saveState(st);
      } else {
        const r = parseRsp(out);
        failed += batch.length;
        st.failed = failed;
        saveState(st);
        for (const p of batch) {
          const rel = relative(base, p).split(sep).join("/");
          failures.push({ op: "upload", file: rel, error: `${r.code} ${r.desc}`.trim(), kind: "failed" });
        }
        console.log(`  ✗ 批次失败(${batch.length}) [${r.code} ${r.desc}] — 已记入失败清单`);
      }
      progress(done, files.length, t0, failed, "上传");
    }
  }
  st.phase = "done";
  st.done = done; st.failed = failed;
  saveState(st);
  console.log(`完成: 提交 ${done} / 总 ${files.length} / 失败 ${failed} / 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

function remoteFiles(rootId) {
  const out = {};
  const walk = (id, prefix) => {
    for (const f of qAll(id)) {
      const rel = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.type === 0) walk(f.id, rel);
      else out[rel] = { size: Number(f.size) || 0, fid: f.fid || null };
    }
  };
  walk(rootId, "");
  return out;
}

async function cmdVerify([base, rootId], opts) {
  console.log("=== 校验（全量拉取云端，可能需要几分钟）===");
  const rfiles = remoteFiles(rootId);
  const local = scanLocal(base);
  const rset = new Set(Object.keys(rfiles));
  const lset = new Set(local);
  const miss = local.filter((f) => !rset.has(f));
  const extra = [...rset].filter((f) => !lset.has(f));
  const zeroMiss = miss.filter((f) => statSync(join(base, f)).size === 0);
  const realMiss = miss.filter((f) => statSync(join(base, f)).size > 0);
  console.log(`  云端 ${Object.keys(rfiles).length} / 本地 ${local.length}`);
  console.log(`  真实缺失 ${realMiss.length}${zeroMiss.length ? `（另有 ${zeroMiss.length} 个 0 字节文件云端不支持，可忽略）` : ""}`);
  for (const m of realMiss.slice(0, 10)) console.log(`     - ${m}`);
  console.log(`  多出/错位 ${extra.length}`);
  for (const e of extra.slice(0, 10)) console.log(`     + ${e}`);

  // --sample N：随机抽 N 个文件真实下载回来比大小（内容完整性抽查，名字比对之上的第二道闸）
  if (opts.sample) {
    const n = Math.max(1, Number(opts.sample) || 5);
    const matched = local.filter((f) => rset.has(f) && rfiles[f].fid && statSync(join(base, f)).size > 0);
    const picks = [...matched].sort(() => Math.random() - 0.5).slice(0, n);
    console.log(`  抽样下载校验 ${picks.length}/${matched.length} 个…`);
    let bad = 0;
    for (const rel of picks) {
      const tmp = join(process.env.TEMP ?? "/tmp", `bulk-sample-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      try {
        cli("download", rfiles[rel].fid, "--out", tmp);
        const ls = statSync(tmp).size, ll = statSync(join(base, rel)).size;
        if (ls !== ll) { bad++; console.log(`     ✗ ${rel} 本地 ${ll}B ≠ 云端 ${ls}B`); }
      } catch (e) {
        bad++; console.log(`     ✗ ${rel} 下载失败: ${String(e.message).slice(0, 60)}`);
      } finally {
        try { unlinkSync(tmp); } catch { /* 本就不存在 */ }
      }
    }
    console.log(bad ? `  ✗ 抽样不一致 ${bad}/${picks.length}` : `  ✓ 抽样 ${picks.length} 个全部一致`);
    if (bad) process.exitCode = 1;
  }
}

function cmdClean([base, rootId], opts) {
  console.log("=== 清理根级错位残留 ===");
  const root = qAll(rootId);
  const localTop = new Set(readdirSync(base));
  const strayFiles = root.filter((f) => f.type !== 0 && !localTop.has(f.name));
  const strayDirs = root.filter((f) => f.type === 0 && !localTop.has(f.name));
  console.log(`  根级错位文件 ${strayFiles.length} 个 / 错位目录 ${strayDirs.length} 个`);
  for (const d of strayDirs) console.log(`   [D] ${d.name}`);
  if (!strayFiles.length && !strayDirs.length) { console.log("  ✓ 无残留"); return; }
  if (!opts.yes) { console.log("  ℹ️ 预演模式，加 --yes 执行删除"); return; }

  const byv = new Map();
  for (const f of strayFiles) {
    const v = f.fileVersion || 1;
    if (!byv.has(v)) byv.set(v, []);
    byv.get(v).push(f.id);
  }
  let n = 0;
  for (const [v, ids] of byv) {
    for (let i = 0; i < ids.length; i += 40) {
      try { cli("rm", ...ids.slice(i, i + 40), "--version", String(v), "--yes"); n += Math.min(40, ids.length - i); } catch { /* verify 兜底 */ }
      execFileSync("sleep", ["1"]);
    }
  }
  console.log(`  已删文件 ${n} 个`);
  let dn = 0;
  for (const d of strayDirs) {
    try { cli("rm", d.id, "--dir", "--recursive", "--yes"); dn++; } catch { /* ignore */ }
    execFileSync("sleep", ["1.2"]);
  }
  console.log(`  已删目录 ${dn} 个`);
}

/** selftest:一条命令的回归底线(临时目录 → 上传 → state → continue 全跳过 → verify → 清理) */
async function cmdSelftest(_pos, opts, failures) {
  const tmp = join(process.env.TEMP ?? "/tmp", `bulk-selftest-${Date.now()}`);
  const tag = Date.now() % 100000;
  const cloudPath = `工作区/bulk-selftest-${tag}`;
  const label = `selftest-${tag}`;
  const steps = [];
  const ok = (name, cond, note = "") => { steps.push(cond); console.log(`  ${cond ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`); };
  console.log("=== bulk selftest ===");
  try {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(join(tmp, "a.txt"), "hello wocloud\n");
    writeFileSync(join(tmp, "b.bin"), Buffer.alloc(64 * 1024, 7));
    writeFileSync(join(tmp, "sub", "c.txt"), "deep\n");

    await cmdBackup([tmp, cloudPath], { label }, failures);
    const st = loadState(label);
    ok("backup + state 落盘", !!st && st.phase === "done" && st.uploaded.length === 3, `uploaded=${st?.uploaded?.length ?? 0}`);

    await cmdBackup([tmp, cloudPath], { label, continue: true }, failures);
    const st2 = loadState(label);
    ok("--continue 全跳过", st2 && st2.done === 0 && st2.uploaded.length === 3, `done=${st2?.done}`);

    const targetId = await resolveCloudPath(cloudPath);
    const rf = remoteFiles(targetId);
    ok("云端文件数=3", Object.keys(rf).length === 3, `实际=${Object.keys(rf).length}`);

    await cmdVerify([tmp, targetId], { sample: 2 });
    ok("verify --sample 通过", process.exitCode !== 1);

    cli("rm", targetId, "--dir", "--recursive", "--yes");
    ok("云端清理", qAll("0").every((f) => f.name !== `bulk-selftest-${tag}`));
  } catch (e) {
    ok("selftest 异常", false, String(e.message).slice(0, 100));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    try { unlinkSync(statePath(label)); } catch { /* 已不存在 */ }
    failures.length = 0;   // selftest 的失败走自己的 steps 记账,不写 failures.json
  }
  const bad = steps.filter((s) => !s).length;
  console.log(bad ? `\n✗ selftest ${bad} 项未通过` : "\n✅ selftest 全部通过");
  if (bad) process.exitCode = 1;
}

// ---------- 入口 ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const opts = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { opts[k] = next; i++; }  // --label 值
    else opts[k] = true;                                                        // 开关
  } else {
    positional.push(a);
  }
}

const CMDS = { backup: cmdBackup, verify: cmdVerify, clean: cmdClean, selftest: cmdSelftest };
if (!CMDS[cmd]) {
  console.log(`用法:
  node tools/wocloud-bulk.mjs backup <本地目录> <云端目录id或路径> [--label 名] [--dry-run] [--resume failures.json] [--continue]
  node tools/wocloud-bulk.mjs verify <本地目录> <云端目录id> [--sample N]
  node tools/wocloud-bulk.mjs clean  <本地目录> <云端目录id> [--yes]
  node tools/wocloud-bulk.mjs selftest            # 一条命令回归:上传/state/continue/verify/清理

  backup 目标支持 32 位目录 id 或云端路径（如 工作区/项目-win/06-projects，缺失段自动创建）。
  进度: <label>-state.json 实时落盘（阶段/已传清单/失败数），外部可随时读取。
  断点: 中断后加 --continue 从状态文件续传，跳过已成功文件。
  失败清单: <label>-failures.json 分 {failed, skipped} 两节（0 字节等预期跳过不算失败）；
            --resume 兼容新旧两种格式，只重跑失败项。
  verify --sample N: 随机抽 N 个文件真实下载回来比大小（内容完整性抽查）。
  上传判定: 优先读 CLI upload --json 的结构化结果，旧版 CLI 输出自动兜底字符串匹配。`);
  process.exit(1);
}

const failures = [];
await CMDS[cmd](positional, opts, failures);

if (failures.length) {
  const out = opts.label ? `${opts.label}-failures.json` : "failures.json";
  const failed = failures.filter((f) => f.kind !== "skipped");
  const skipped = failures.filter((f) => f.kind === "skipped");
  writeFileSync(out, JSON.stringify({ failed, skipped }, null, 2));
  if (failed.length) {
    console.log(`\n⚠️ 失败 ${failed.length} 项 / 预期跳过 ${skipped.length} 项，已写入 ${out}（--resume ${out} 只重跑失败项）`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ 无真失败；${skipped.length} 项预期跳过（0 字节等），已记录到 ${out}`);
  }
} else if (cmd === "backup") {
  console.log("\n✅ 全部成功，无失败清单");
}
