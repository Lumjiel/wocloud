#!/usr/bin/env node
/**
 * 兼容 shim —— CLI 真身已上移到 ../wocloud.mjs（协议在 ../wocloud-core.mjs）。
 *
 * 保留本文件是因为 tools/wocloud-bulk.mjs 与 cli/bench-upload.mjs
 * 仍以子进程方式调用这个路径；行为与真身完全一致。
 */
import { run } from "../wocloud.mjs";

run(process.argv.slice(2)).catch((e) => {
  console.error("运行失败:", e?.message || e);
  process.exit(1);
});
