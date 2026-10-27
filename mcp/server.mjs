#!/usr/bin/env node
/**
 * wocloud-mcp — 联通云盘 MCP Server（零依赖）
 *
 * 入口只做一件事：选传输层。
 *   - 默认            stdio（本地客户端，行为与旧版完全一致）
 *   - --http [--port] Streamable HTTP（云端部署，多设备共用一份）
 *
 * 协议分发在 protocol.mjs，25 个工具在 tools.mjs，
 * 两套传输共用同一份实现——不会分叉。
 *
 * 依赖：仅 Node 18+ 原生能力，无 npm 包。
 *
 * 用法：
 *   node mcp/server.mjs                        # stdio
 *   node mcp/server.mjs --http --port 8788     # HTTP（需 MCP_TOKEN）
 *   node mcp/server.mjs --http --help
 */

import { ALL_TOOLS, SERVER_NAME, SERVER_VERSION } from "./tools.mjs";
import { startStdio } from "./transport/stdio.mjs";
import { startHttp } from "./transport/http.mjs";

function parseArgs(argv) {
  const opts = {
    http: false,
    port: 8788,
    host: "127.0.0.1",
    path: "/mcp",
    token: process.env.MCP_TOKEN || null,
    noAuth: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} 需要一个值`);
      return v;
    };
    switch (a) {
      case "--http": opts.http = true; break;
      case "--port": opts.port = Number(next()); break;
      case "--host": opts.host = next(); break;
      case "--path": {
        const v = next();
        opts.path = v.startsWith("/") ? v : `/${v}`;
        break;
      }
      case "--token": opts.token = next(); break;
      case "--no-auth": opts.noAuth = true; break;
      case "--help":
      case "-h": opts.help = true; break;
      default: throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

const HELP = `wocloud-mcp v${SERVER_VERSION}

用法:
  node mcp/server.mjs                         stdio（默认，本地客户端）
  node mcp/server.mjs --http [选项]            Streamable HTTP（远程部署）

HTTP 选项:
  --port <n>       监听端口，默认 8788
  --host <addr>    监听地址，默认 127.0.0.1（对外部署用 0.0.0.0）
  --path <p>       MCP 端点路径，默认 /mcp
  --token <t>      Bearer 鉴权口令，也可用环境变量 MCP_TOKEN
  --no-auth        关闭鉴权（仅本机调试，勿对公网开放）
  -h, --help       显示本帮助

示例:
  MCP_TOKEN=$(openssl rand -hex 16) node mcp/server.mjs --http --host 0.0.0.0

健康检查:
  GET /healthz     （不需要鉴权）

客户端调用示例:
  curl -s http://127.0.0.1:8788/mcp \\
    -H "Authorization: Bearer $MCP_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[${SERVER_NAME}] ${e.message}\n`);
    console.error(HELP);
    process.exit(2);
  }

  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (!opts.http) {
    startStdio({ name: SERVER_NAME, toolCount: ALL_TOOLS.length });
    return;
  }

  if (!opts.token && !opts.noAuth) {
    console.error(`[${SERVER_NAME}] 拒绝启动：HTTP 模式没有任何鉴权。`);
    console.error("  这个 server 带有 rm / purge / empty_trash 这类破坏性工具，");
    console.error("  暴露成无鉴权端点等于把云盘删除权开放出去。\n");
    console.error("  MCP_TOKEN=$(openssl rand -hex 16) node mcp/server.mjs --http --host 0.0.0.0");
    console.error("  本机调试可加 --no-auth。");
    process.exit(1);
  }

  if (opts.noAuth && opts.host === "0.0.0.0") {
    console.error(`[${SERVER_NAME}] 警告：--no-auth 且监听 0.0.0.0，任何能访问该端口的人都能删除你的云盘文件。`);
  }

  await startHttp({
    name: SERVER_NAME,
    toolCount: ALL_TOOLS.length,
    port: opts.port,
    host: opts.host,
    token: opts.noAuth ? null : opts.token,
    path: opts.path,
  });
}

main().catch((e) => {
  console.error(`[${SERVER_NAME}] 启动失败: ${e?.stack || e}`);
  process.exit(1);
});
