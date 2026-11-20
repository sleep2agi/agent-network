// 兼容壳：ACP 的 JSON-RPC stdio 客户端已提到 ../acp-runner/client（grok 与 agy 共用）。
// 这里保留原路径的导出面，避免 grok 侧几十处 import 一起改；新代码请直接引 acp-runner。
export {
  GrokAcpClient,
  grokAgentStdioArgs,
  formatJsonRpcErrorForTest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type JsonRpcNotification,
} from "../acp-runner/client";
