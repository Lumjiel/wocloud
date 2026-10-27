/**
 * protocol.mjs — JSON-RPC 2.0 分发层
 *
 * 这一层不碰任何 I/O：不读 stdin、不写 stdout、不碰 HTTP socket。
 * 它只做三件事：
 *   1. 认方法名（initialize / ping / tools/list / tools/call）
 *   2. 组装"请求级运行时"（rt）——进度回调、已推分片、取消信号
 *   3. 把结果包成 MCP 规定的形状（{content:[...]} / isError）
 *
 * 传输层（transport/stdio.mjs、transport/http.mjs）负责把字节变成消息对象，
 * 再提供一个 io.send() 把消息写回去。所以同一份分发逻辑可以同时挂在
 * stdio 和 Streamable HTTP 上，不会分叉。
 */

import {
  ALL_TOOLS, SERVER_NAME, SERVER_VERSION,
  callTool, isTokenError, textResult, errorResult, setTokenOverride,
} from "./tools.mjs";
import { resolveToken, refreshToken } from "./lib/wocloud-core.mjs";

/**
 * 支持的协议版本，新的在前。
 *
 * 2026-07-28 是目前现行版本，这一版移除了协议级会话（Mcp-Session-Id）、
 * 移除了 GET 的独立 SSE 流、移除了 Last-Event-ID 断线续传——MCP 变成
 * 彻底无状态：每个请求自带全部上下文，服务端不许从"上一条请求"推断任何东西。
 *
 * 本实现从一开始就没有会话概念（单用户、token 全局），所以吃新版本零成本；
 * 而 HTTP 传输对 GET/DELETE 一律回 405，正合新规范的要求。
 */
export const PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

const DEFAULT_PROTOCOL_VERSION = "2026-07-28";

const INSTRUCTIONS =
  '联通云盘 MCP。目录/文件 id 可用 wocloud_ls 查询，根目录为 "0"。' +
  "破坏性操作（rename/mv/rm/restore/purge/empty_trash）必须显式传 confirm:true，" +
  "否则只会返回预演计划。上传大文件是长任务，可分多次调用并配合 progressToken 观察进度。";

// ---------------------------------------------------------------- 内部助手

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function replyError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * 造一个绑定到"单次调用"的进度发射器。
 *
 * 之前 progressToken / progressValue / lastChunkSeen 都是模块级全局，
 * 串行队列下单客户端不出问题——但一旦多客户端并发，A 的进度会推到 B 身上。
 * 现在每次 tools/call 现造一个，闭包持有自己的 token 和累加值，天然隔离。
 */
export function makeProgress(send, progressToken) {
  let value = 0;
  return function progress(delta, message) {
    if (progressToken === null || progressToken === undefined) return;
    value += delta;
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken,
        progress: value,
        ...(message ? { message } : {}),
      },
    });
  };
}

/** 造一个"请求级运行时"，工具可以从中读进度回调和取消信号 */
function makeRuntime(io, id, progressToken) {
  return {
    progress: makeProgress(io.send, progressToken),
    chunkSeen: new Map(),
    aborted: () => io.isAborted?.(id) === true,
  };
}

/** token 失效时自动续期并重试一次，避免每次都要重启客户端重新登录 */
async function retryAfterTokenRefresh(name, args, rt) {
  const base = resolveToken(process.env.WOCLOUD_TOKEN);
  const fresh = base ? await refreshToken(base) : null;
  if (!fresh) return null;
  setTokenOverride(fresh);
  return await callTool(name, args, rt);
}

// ---------------------------------------------------------------- 分发

/**
 * 处理一条 JSON-RPC 消息。
 *
 * @param {object} msg 解析后的 JSON-RPC 消息（请求 / 通知）
 * @param {object} io 传输层提供的写回能力
 * @param {(msg: object) => void} io.send        写回一条消息
 * @param {(id: any) => boolean} [io.isAborted]  该请求是否已被客户端取消
 * @param {(id: any) => void}    [io.onCancelled] 记录一条取消通知
 */
export async function handleMessage(msg, io) {
  const hasId = msg?.id !== undefined && msg?.id !== null;
  const isNotification = !hasId;
  const { id, method, params } = msg || {};

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      if (isNotification) return;
      io.send(reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      }));
      return;
    }

    case "ping":
      if (!isNotification) io.send(reply(id, {}));
      return;

    case "tools/list":
      if (isNotification) return;
      io.send(reply(id, {
        tools: ALL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }));
      return;

    case "notifications/cancelled": {
      // 客户端取消请求：交给传输层记录，在途的下一个检查点会中断
      const rid = params?.requestId;
      if (rid !== undefined && rid !== null) io.onCancelled?.(rid);
      return;
    }

    case "tools/call": {
      // 已取消且尚未开始：直接跳过，不响应（JSON-RPC 允许被取消的请求不回包）
      if (io.isAborted?.(id)) return;

      const rt = makeRuntime(io, id, params?._meta?.progressToken ?? null);
      try {
        let result = await callTool(params?.name, params?.arguments, rt);

        if (isTokenError(result)) {
          const retried = await retryAfterTokenRefresh(params?.name, params?.arguments, rt);
          if (retried) result = retried;
        }

        // MCP 规定工具结果必须是 {content:[...]}；run() 返回裸对象的统一包装
        result = (result && Array.isArray(result.content)) ? result : textResult(result);

        // 执行期间被取消：按规范可以不响应
        if (io.isAborted?.(id)) return;
        if (!isNotification) io.send(reply(id, result));
      } catch (e) {
        if (!io.isAborted?.(id) && !isNotification) {
          io.send(reply(id, errorResult(e?.message || String(e))));
        }
      }
      return;
    }

    default:
      // 未知通知直接忽略；未知请求按 JSON-RPC 规范报 MethodNotFound
      if (isNotification) return;
      if (typeof method === "string" && method.startsWith("notifications/")) return;
      io.send(replyError(id, -32601, `Method not found: ${method}`));
  }
}

/** 解析失败时的标准错误（-32700），传输层直接用 */
export function parseError(message = "Parse error") {
  return replyError(null, -32700, message);
}

export { replyError };
