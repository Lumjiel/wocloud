/**
 * 兼容 shim —— 核心已上移到 ../../wocloud-core.mjs（唯一真源）。
 * mcp/server.mjs 的 import 路径保持不变，全部命名导出原样转发。
 */
export * from "../../wocloud-core.mjs";
