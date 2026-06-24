/**
 * RFC-020 §3.1 — Feishu (Lark) IM channel public surface.
 *
 * - `FeishuAdapter`         — IMAdapter implementation backed by `@larksuiteoapi/node-sdk` WSClient.
 * - `startFeishuBridge`     — entry point spawned by agent-node for SDK runtimes.
 * - `loadFeishuChannelConfig` — loader for `.anet/nodes/<node>/channels/feishu/`.
 *
 * Tracking: issues #179 (parent RFC), #182 (P0 tracker).
 */
export { FeishuAdapter } from "./adapter.js";
export { startFeishuBridge } from "./bridge.js";
export type { FeishuBridgeOptions } from "./bridge.js";
export { loadFeishuChannelConfig } from "./config.js";
export type {
  FeishuAccessList,
  FeishuChannelConfig,
  FeishuChannelEnv,
} from "./config.js";
