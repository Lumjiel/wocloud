#!/usr/bin/env node
/**
 * PC 端真实上传回归（平板是只读端，这类测试只能在 Windows / Mac 上跑）
 *
 * 用法：
 *   node tools/pc-upload-regression.mjs                 # 小文件 + 20MB 多分片 + 覆盖写
 *   node tools/pc-upload-regression.mjs --big-mb 50     # 改大文件体积
 *   node tools/pc-upload-regression.mjs --limit-test    # 追加单目录 101 文件上限测试（慢）
 *   node tools/pc-upload-regression.mjs --keep          # 保留云端测试目录（默认测完删除并清回收站）
 *
 * 前置：
 *   1. 本仓库当前目录（wocloud.mjs / wocloud-core.mjs 同级）
 *   2. 已登录：`node wocloud.mjs doctor` 通过
 *   3. 云端根目录可写（测试目录建在根下，名字 wocloud-regression-<时间戳>）
 *
 * 退出码：0 全部通过；1 有失败项（会打印失败清单，测试目录默认仍会清理）
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const optNum = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};

const BIG_MB = optNum("--big-mb", 20);
const LIMIT_TEST = flag("--limit-test");
const CRASH_TEST = flag("--crash-test");
const KEEP = flag("--keep");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const DIR_NAME = `wocloud-regression-${STAMP}`;

let pass = 0;
const failures = [];
const ok = (cond, name, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};

function run(args, { allowFail = false } = {}) {
  const r = spawnSync(process.execPath, ["wocloud.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`命令失败: wocloud ${args.join(" ")}\n${(r.stderr || r.stdout || "").trim()}`);
  }
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function runJson(args) {
  const { out } = run(args);
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`不是 JSON 输出: ${args.join(" ")}`);
  return JSON.parse(out.slice(start));
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function listDir(dirId) {
  const res = runJson(["ls", "--dir", dirId, "--json", "--limit", "1000"]);
  return res?.RSP?.DATA?.files ?? [];
}

console.log(`\nwocloud 上传回归 · ${new Date().toLocaleString()}`);
console.log(`  测试目录: ${DIR_NAME}  大文件: ${BIG_MB} MB  限制测试: ${LIMIT_TEST ? "开" : "关"}\n`);

// ---------- 0. 体检 ----------
console.log("▶ 0. 凭证与上传区域");
const doctor = run(["doctor"], { allowFail: true });
ok(doctor.code === 0, "doctor 通过", doctor.out.split("\n").find((l) => l.includes("鉴权"))?.trim() || "");

// ---------- 1. 建测试目录 ----------
console.log("\n▶ 1. 建云端测试目录");
run(["mkdir", DIR_NAME]);
let rootFiles = listDir("0");
let dir = rootFiles.find((f) => f.name === DIR_NAME);
ok(!!dir, "目录已创建", dir?.id || "");
if (!dir) {
  console.error("无法定位测试目录，终止");
  process.exit(1);
}
const dirId = dir.id;

const local = mkdtempSync(join(tmpdir(), "wocloud-regression-"));
const cleanupLocal = () => { try { rmSync(local, { recursive: true, force: true }); } catch {} };

async function uploadAndVerify(localPath, label) {
  const name = localPath.split(/[\\/]/).pop();
  const r = run(["upload", localPath, "--dir", dirId], { allowFail: true });
  ok(r.code === 0 && /上传成功|秒传命中/.test(r.out + r.err), `${label} 上传`, (r.out + r.err).split("\n").find((l) => /上传成功|秒传命中|失败/.test(l))?.trim() || "");
  // 服务端字段：文件用 fid（长串），目录用 id；大小字段是 size 不是 fileSize
  const files = listDir(dirId).filter((f) => f.name === name);
  const size = statSync(localPath).size;
  ok(files.some((f) => Number(f.size) === size), `${label} 云端大小一致`, `${size} 字节`);

  const file = files[files.length - 1];
  if (!file) return;
  const outPath = join(local, `back-${label}.bin`);
  const dl = run(["download", file.fid, "--out", outPath], { allowFail: true });
  ok(dl.code === 0, `${label} 回下载`, (dl.out + dl.err).trim().split("\n").pop() || "");
  if (dl.code === 0) {
    ok(sha256(outPath) === sha256(localPath), `${label} 回下载 SHA256 一致`);
  }
}

// ---------- 2. 小文件（单分片） ----------
console.log("\n▶ 2. 小文件（1 KB，单分片）");
const small = join(local, "small.txt");
writeFileSync(small, randomBytes(1024));
await uploadAndVerify(small, "小文件");

// ---------- 3. 大文件（多分片） ----------
console.log(`\n▶ 3. 大文件（${BIG_MB} MB，多分片）`);
const big = join(local, "big.bin");
writeFileSync(big, randomBytes(BIG_MB * 1024 * 1024));
await uploadAndVerify(big, "大文件");

// ---------- 4. 同名覆盖语义 ----------
console.log("\n▶ 4. 同名覆盖语义（决定是否要「临时名→备份→rename」）");
// 同名覆盖必须同名：两版放不同本地目录，basename 都是 overwrite.txt
const bodyA = randomBytes(4096), bodyB = randomBytes(8192);
const over1 = join(local, "v1", "overwrite.txt");
const over2 = join(local, "v2", "overwrite.txt");
mkdirSync(join(local, "v1"), { recursive: true });
mkdirSync(join(local, "v2"), { recursive: true });
writeFileSync(over1, bodyA);
writeFileSync(over2, bodyB);

const u1 = run(["upload", over1, "--dir", dirId], { allowFail: true });
ok(u1.code === 0, "第一版上传", (u1.out + u1.err).trim().split("\n").pop() || "");
const u2 = run(["upload", over2, "--dir", dirId, "--no-verify"], { allowFail: true });
ok(u2.code === 0, "同名第二版上传", (u2.out + u2.err).trim().split("\n").pop() || "");

const sameName = listDir(dirId).filter((f) => f.name === "overwrite.txt");
console.log(`     云端同名条目数: ${sameName.length}`);
if (sameName.length === 1) {
  const f = sameName[0];
  const outPath = join(local, "back-overwrite.bin");
  const dl = run(["download", f.fid, "--out", outPath], { allowFail: true });
  if (dl.code !== 0) {
    console.log(`     → 回下载失败: ${(dl.out + dl.err).trim().split("\n").pop()}`);
  }
  if (dl.code === 0) {
    const h = sha256(outPath);
    const which = h === createHash("sha256").update(bodyB).digest("hex") ? "第二版（覆盖）"
      : h === createHash("sha256").update(bodyA).digest("hex") ? "第一版（未覆盖）" : "未知内容";
    console.log(`     → 同名文件是: ${which}；大小 ${f.size}`);
    ok(which !== "未知内容", "同名条目内容可判定", which);
  }
} else {
  console.log("     → 服务端保留多份同名文件，上传不会覆盖旧文件");
}

// ---------- 4.5 覆盖中断安全（可选） ----------
if (CRASH_TEST) {
  console.log("\n▶ 5. 覆盖中断安全（同名上传中途被杀，旧文件是否还在）");
  const size = 64 * 1024 * 1024;   // 4 个分片：确保能在「已提交部分分片、尚未完成」时中断
  const oldBody = randomBytes(size);
  const newBody = randomBytes(size);
  const oldHash = createHash("sha256").update(oldBody).digest("hex");
  const newHash = createHash("sha256").update(newBody).digest("hex");

  const dirA = join(local, "crashA");
  mkdirSync(dirA, { recursive: true });
  const aPath = join(dirA, "crash.bin");
  writeFileSync(aPath, oldBody);
  const tA = Date.now();
  run(["upload", aPath, "--dir", dirId]);
  const uploadMs = Date.now() - tA;
  const before = listDir(dirId).find((f) => f.name === "crash.bin");
  ok(!!before && Number(before.size) === size, "旧版本已就位", before ? `${before.size} 字节` : "未找到");

  const dirB = join(local, "crashB");
  mkdirSync(dirB, { recursive: true });
  const bPath = join(dirB, "crash.bin");
  writeFileSync(bPath, newBody);
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["wocloud.mjs", "upload", bPath, "--dir", dirId], { cwd: ROOT, stdio: "ignore" });
  // 在「上次用时的 65%」处杀：多分片时通常已提交前几片、还没传完，才测得到覆盖时机
  const killAfter = Math.max(3000, Math.min(Math.round(uploadMs * 0.65), uploadMs - 1500));
  console.log(`     首次上传用时 ${(uploadMs / 1000).toFixed(1)}s，这次将在 ${(killAfter / 1000).toFixed(1)}s 时中断`);
  await new Promise((r) => setTimeout(r, killAfter));
  child.kill();
  await new Promise((r) => child.on("exit", r));

  const after = listDir(dirId).find((f) => f.name === "crash.bin");
  if (!after) {
    console.log("     → 中断后云端已没有 crash.bin（旧文件被提前删除）");
    failures.push("中断上传不应删除旧文件");
  } else {
    console.log(`     → 中断后条目还在，大小 ${after.size}（旧 ${size} / 新 ${size}）`);
    const outPath = join(local, "back-crash.bin");
    const dl = run(["download", after.fid, "--out", outPath], { allowFail: true });
    if (dl.code !== 0) {
      console.log(`     → 旧文件读不出来: ${(dl.out + dl.err).trim().split("\n").pop()}`);
      failures.push("中断上传后旧文件应可读");
    } else {
      const h = sha256(outPath);
      const state = h === oldHash ? "旧文件完好（覆盖在最后一步生效）"
        : h === newHash ? "已换成新文件（中断时已完成）"
        : "内容损坏/半截（覆盖是破坏性的）";
      console.log(`     → 回下载结果: ${state}`);
      ok(state !== "内容损坏/半截（覆盖是破坏性的）", "中断不损坏旧文件", state);
    }
  }

  // 中断后再传一次，确认能恢复
  const retry = run(["upload", bPath, "--dir", dirId, "--no-verify"], { allowFail: true });
  ok(retry.code === 0, "中断后重传成功", (retry.out + retry.err).trim().split("\n").pop() || "");
  const final = listDir(dirId).find((f) => f.name === "crash.bin");
  if (final) {
    const outPath = join(local, "back-crash2.bin");
    const dl = run(["download", final.fid, "--out", outPath], { allowFail: true });
    ok(dl.code === 0 && sha256(outPath) === newHash, "重传后内容正确");
  }
}

// ---------- 5. 单目录 101 文件上限（可选） ----------
if (LIMIT_TEST) {
  console.log("\n▶ 5. 单目录文件数上限（101 个小文件）");
  const sub = join(local, "many");
  run(["mkdir", "many", "--dir", dirId]);
  const subDir = listDir(dirId).find((f) => f.name === "many");
  if (subDir) {
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 101; i++) writeFileSync(join(sub, `f${String(i).padStart(3, "0")}.txt`), `#${i}`);
    const push = run(["push", sub, "--to", subDir.id, "--files", "5"], { allowFail: true });
    const text = push.out + push.err;
    const warned = /上限|100/.test(text);
    const mentioned = text.split("\n").filter((l) => /上限|失败|完成:/.test(l)).slice(0, 6).join("\n     ");
    console.log(`     ${mentioned}`);
    const uploaded = listDir(subDir.id).length;
    console.log(`     实际上传: ${uploaded} 个`);
    ok(uploaded >= 100, "至少传进 100 个", `${uploaded}`);
    console.log(`     预检提示: ${warned ? "出现" : "未出现（首轮目录为空属正常）"}`);
  }
}

// ---------- 6. 清理 ----------
console.log("\n▶ 6. 清理");
if (KEEP) {
  console.log(`  已保留云端目录: ${DIR_NAME} (id=${dirId})`);
  console.log(`  本地临时目录: ${local}`);
} else {
  const rm = run(["rm", dirId, "--dir", "--recursive", "--yes"], { allowFail: true });
  ok(rm.code === 0, "云端测试目录已删除", (rm.out + rm.err).trim().split("\n").pop() || "");
  const trash = runJson(["trash", "--json", "--limit", "100"]);
  const items = trash?.RSP?.DATA ?? [];
  const hit = items.find((it) => it.name === DIR_NAME);
  if (hit) {
    const pg = run(["purge", hit.deleteNo, "--yes"], { allowFail: true });
    ok(pg.code === 0, "回收站已彻底清除测试目录", `deleteNo=${hit.deleteNo}`);
  } else {
    console.log("  回收站里没找到测试目录（可能删除有延迟，稍后手动 `trash` 核对）");
  }
  cleanupLocal();
  console.log("  本地临时文件已清理");
}

// ---------- 汇总 ----------
console.log(`\n${failures.length ? "❌" : "✅"} ${pass} 项通过 · ${failures.length} 项失败`);
if (failures.length) {
  failures.forEach((f) => console.log(`   - ${f}`));
  process.exit(1);
}
