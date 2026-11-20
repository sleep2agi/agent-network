// 兼容壳：ACP 的 session/update 归约器已提到 ../acp-runner/events（grok 与 agy 共用同一套协议事件）。
// 保留原导出面，grok 侧 import 不用一起改。
export {
  newGrokTurnState,
  reduceGrokAcpNotification,
  reduceGrokAcpNotifications,
  type GrokAcpNotification,
  type ReduceResult,
  type GrokTurnState,
} from "../acp-runner/events";
