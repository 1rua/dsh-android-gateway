/**
 * Gateway Protocol v2.1 HTTP 传输层入口。
 *
 * 只导出传输层接口与 handler 工厂；插件入口 `src/index.ts` 依赖
 * `createGatewayHttpHandler`，其余模块按需直接从具体文件导入。
 */
export * from "./contract.js";
export { createGatewayHttpHandler } from "./server.js";
export {
  createFailureEnvelope,
  createSuccessEnvelope,
  httpStatusForError,
  type EnvelopeIdentity,
} from "./envelope.js";
