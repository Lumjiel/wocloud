/**
 * transport/stdio.mjs — stdio 传输
 *
 * 按行切分 newline-delimited JSON-RPC，串行处理（保证响应顺序与请求顺序一致），
 * stdin 关闭时不立刻退出，等在途请求跑完再走——否则会掐断正在进行的上传。
 *
 * 诊断信息一律走 stderr，stdout 只写协议流。
 */

import { handleMessage } from "../protocol.mjs";

export function startStdio({ name = "wocloud-mcp", toolCount = 0 } = {}) {
  const OUT = process.stdout;
  const send = (msg) => OUT.write(JSON.stringify(msg) + "\n");

  /** 已被客户端取消的请求 id */
  const cancelled = new Set();
  const io = {
    send,
    isAborted: (id) => cancelled.has(id),
    onCancelled: (rid) => {
      cancelled.add(rid);
      console.error(`[${name}] 请求 ${rid} 被客户端取消`);
    },
  };

  // 在途请求计数：stdin 关闭时不能立刻 exit，否则会掐断正在进行的 API 调用
  let pendingRequests = 0;
  let stdinEnded = false;
  let exiting = false;

  function maybeExit() {
    if (exiting || !stdinEnded) return;
    exiting = true;
    // 递归检查：stdout 冲刷后、且确实没有任何在途请求时才退出；
    // 每 200ms 复查一次，直到请求清零（不会盲目定时强杀）
    const tryExit = () => {
      if (pendingRequests === 0) { process.exit(0); }
      setTimeout(tryExit, 200).unref();
    };
    process.stdout.write("", tryExit);
  }

  async function handle(msg) {
    const isReq = msg?.id !== undefined && msg?.id !== null;
    if (isReq) pendingRequests++;
    try {
      await handleMessage(msg, io);
    } finally {
      if (isReq) { pendingRequests--; maybeExit(); }
    }
  }

  // 串行处理消息：stdio 客户端通常假设响应顺序与请求顺序一致
  let queue = Promise.resolve();
  function enqueue(msg) {
    queue = queue.then(() => handle(msg)).catch((e) => {
      if (msg?.id !== undefined && msg?.id !== null) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e?.message || "Internal error" } });
      }
    });
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }   // 非 JSON 行（极少见）直接忽略
      enqueue(msg);
    }
  });
  process.stdin.on("end", () => { stdinEnded = true; maybeExit(); });

  console.error(`[${name}] 已启动，${toolCount} 个工具就绪（stdio）`);
}
