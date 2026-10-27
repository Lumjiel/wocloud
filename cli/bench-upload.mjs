#!/usr/bin/env node
/**
 * 上传性能基准：测试不同并发数下的上传阶段吞吐
 * 用法: node bench-upload.mjs <目录id> [文件大小MB] [并发列表]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

const dirId = process.argv[2] || "0";
const sizeMB = Number(process.argv[3] || 96);
const concList = (process.argv[4] || "2,3,6,12").split(",").map(Number);
const RUNS = 2;
const TMP = "/tmp/wobench.bin";

console.log(`文件 ${sizeMB}MB · 每档 ${RUNS} 次取最快 · 目标目录 ${dirId}\n`);

const results = [];
for (const c of concList) {
  let best = Infinity, bestMBs = 0;
  for (let i = 0; i < RUNS; i++) {
    // 每次生成不同内容，避免命中秒传
    writeFileSync(TMP, randomBytes(sizeMB * 1024 * 1024));
    let out = "";
    try {
      out = execFileSync(
        process.execPath,
        ["wocloud-cli.mjs", "upload", TMP, "--dir", dirId, "--concurrency", String(c)],
        { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
      );
    } catch (e) { out = String(e.stdout || ""); }
    const m = out.match(/上传 ([\d.]+)s\s*\(并发 \d+, ([\d.]+) MB\/s\)/);
    if (m) {
      const t = Number(m[1]);
      if (t < best) { best = t; bestMBs = Number(m[2]); }
    }
  }
  results.push({ c, best, bestMBs });
  console.log(`并发 ${String(c).padStart(2)} : 上传阶段 ${best.toFixed(2)}s  →  ${bestMBs.toFixed(1)} MB/s`);
}

try { unlinkSync(TMP); } catch { /* ignore */ }

console.log("\n=== 结论 ===");
const fastest = results.reduce((a, b) => (a.bestMBs > b.bestMBs ? a : b));
console.log(`最快: 并发 ${fastest.c} → ${fastest.bestMBs.toFixed(1)} MB/s`);
