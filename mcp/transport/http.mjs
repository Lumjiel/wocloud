/**
 * transport/http.mjs — Streamable HTTP 传输（零依赖，node:http）
 *
 * 目标协议版本 2026-07-28。这一版 MCP 已经移除了协议级会话
 * （Mcp-Session-Id）、GET 独立 SSE 流和 Last-Event-ID 断线续传，
 * 所以本实现只在 POST 上做请求/响应，GET 和 DELETE 一律 405——
 * 正好是新规范要求的行为，服务端也不签发任何 session id。
 *
 * 进度通知：客户端在 _meta.progressToken 里带 token 时，响应切到
 * text/event-stream，notifications/progress 就写在同一个流里；
 * 没带 token 就用普通 application/json 一次返回。
 *
 * 并发：stdio 版靠串行队列绕过了并发问题，这里必须显式限制——
 * 复用 wocloud-core 里已有的信号量（GLOBAL_MAX_INFLIGHT），
 * 防止多客户端同时打满联通云盘接口。
 */

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { handleMessage, parseError, PROTOCOL_VERSIONS } from "../protocol.mjs";
import { makeSemaphore, GLOBAL_MAX_INFLIGHT } from "../lib/wocloud-core.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/** 读请求体；超限/出错时已经回过包，返回 null */
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const fail = (status, payload) => {
      if (done) return;
      done = true;
      sendJson(res, status, payload);
      req.destroy();
      resolve(null);
    };

    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request body too large" } });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => fail(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Bad request" } }));
  });
}

function bearerOf(req) {
  const raw = req.headers.authorization;
  if (!raw || !raw.toLowerCase().startsWith("bearer ")) return null;
  return raw.slice(7).trim();
}

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function startHttp({
  name = "wocloud-mcp",
  toolCount = 0,
  port = 8788,
  host = "127.0.0.1",
  token = null,
  path = "/mcp",
} = {}) {
  const semaphore = makeSemaphore(GLOBAL_MAX_INFLIGHT);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      console.error(`[${name}] 未捕获异常:`, e?.stack || e);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");

    // 健康检查：不带鉴权，给 pm2 / Nginx / 监控用
    if (url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        name,
        tools: toolCount,
        protocolVersions: PROTOCOL_VERSIONS,
        endpoint: path,
      });
      return;
    }

    if (url.pathname !== path) {
      sendJson(res, 404, { error: "not found", endpoint: path });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...BASE_HEADERS,
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version",
      });
      res.end();
      return;
    }

    // 2026-07-28：会话已移除，没有 GET 流、没有 DELETE 结束会话
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed", allow: "POST" }, { Allow: "POST, OPTIONS" });
      return;
    }

    if (token) {
      const got = bearerOf(req);
      if (!sameSecret(got, token)) {
        // WWW-Authenticate 的值只放固定字符，不放任何用户输入
        sendJson(res, 401, { error: "unauthorized" }, {
          "WWW-Authenticate": 'Bearer realm="wocloud-mcp"',
        });
        return;
      }
    }

    const body = await readBody(req, res);
    if (body === null) return;

    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      sendJson(res, 400, parseError());
      return;
    }

    // JSON-RPC 批量请求在 MCP 里已被移除
    if (Array.isArray(msg)) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Batch requests are not supported" },
      });
      return;
    }

    const isRequest = msg?.id !== undefined && msg?.id !== null;
    const progressToken = msg?.params?._meta?.progressToken;
    const wantsStream = progressToken !== undefined && progressToken !== null;

    let aborted = false;
    res.on("close", () => {
      if (!res.writableEnded) aborted = true;
    });

    let streamHeadersSent = false;
    let jsonPayload = null;

    const send = (m) => {
      if (wantsStream) {
        if (!streamHeadersSent) {
          streamHeadersSent = true;
          res.writeHead(200, {
            ...BASE_HEADERS,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // 让 Nginx 不要缓冲 SSE
            "X-Accel-Buffering": "no",
          });
          if (typeof res.flushHeaders === "function") res.flushHeaders();
        }
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(m)}\n\n`);
        return;
      }
      // 非流式：只留响应（带 id 的那条），通知无处可投递，丢弃
      if (m?.id !== undefined && m?.id !== null) jsonPayload = m;
    };

    const io = {
      send,
      isAborted: () => aborted,
      onCancelled: (rid) => console.error(`[${name}] 请求 ${rid} 被客户端取消`),
    };

    // 一次请求占一个全局并发位：多客户端同时打进来也不会把云盘接口打满
    await semaphore(() => handleMessage(msg, io));

    if (!isRequest) {
      sendJson(res, 202, { accepted: true });
      return;
    }
    if (wantsStream) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (aborted) return;   // 客户端已断开，不必回包

    sendJson(res, 200, jsonPayload ?? {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32603, message: "No response produced" },
    });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const where = `http://${host === "0.0.0.0" ? "<本机IP>" : host}:${port}${path}`;
      console.error(`[${name}] 已启动，${toolCount} 个工具就绪（${where}）`);
      console.error(`[${name}] 鉴权：${token ? "Bearer token 已启用" : "已关闭（--no-auth，勿对公网开放）"}`);
      resolve(server);
    });
  });
}
