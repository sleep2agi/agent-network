/**
 * RFC-020 §2.5 / RFC-002 §2.2 — Feishu bridge worker.
 *
 * Entry point spawned by agent-node when a node profile has `channels.feishu`
 * enabled. Per Vincent 2026-06-24 decision, the first-cut is the simplified
 * "agent-node direct bridge" model, not the full commhub-gateway:
 *
 *   - This worker owns the FeishuAdapter and its WSClient connection.
 *   - Inbound IM event → access whitelist gate → forward to agent-node's main
 *     `think()` via parent IPC.
 *   - think() result → adapter.send() back to the originating conversation.
 *
 * Differences vs RFC-020 §2.5 full commhub-gateway path:
 *   - No separate gateway ntok_ / dedicated commhub alias.
 *   - IM messages do NOT pass through commhub task dispatch.
 *   - Feishu messages do NOT appear in Dashboard topology / Chat.
 *
 * The full §2.9 path (meta_json columns, SSE passthrough, persisted
 * IMCorrelationStore) lands as the follow-up PR after this demo ships
 * — tracked in #182.
 *
 * Milestones:
 *   M1 (this file): worker entry scaffold.
 *   M2: load config + instantiate adapter + WSClient.
 *   M3: parent-IPC contract for think() round-trip, outbound send.
 *   M4: agent-node spawn integration (fork(this) wired by agent-node).
 *   M5: group @bot trigger, image up/down, Docker smoke.
 */
import { FeishuAdapter } from "./adapter.js";
import { loadFeishuChannelConfig } from "./config.js";

export interface FeishuBridgeOptions {
  /** Absolute path to `.anet/nodes/<node>/channels/feishu/`. */
  channelDir: string;
  /** Node alias — used for audit log + IPC framing. */
  nodeAlias: string;
}

/**
 * Wire and start the Feishu bridge. Resolves once the underlying WSClient is
 * connected and the EventDispatcher is registered.
 *
 * Intended to be the worker's `main()` — agent-node will spawn this file as a
 * child process and pass `FeishuBridgeOptions` through CLI args or env.
 */
export async function startFeishuBridge(
  _opts: FeishuBridgeOptions,
): Promise<void> {
  // M2 outline:
  //   const config = loadFeishuChannelConfig(_opts.channelDir);
  //   const adapter = new FeishuAdapter();
  //   await adapter.init({ platform: "feishu", connectionName: _opts.nodeAlias,
  //                        ingressMode: "socket", platformConfig: config });
  //   await adapter.start(async (event) => {
  //     if (!isAllowed(event, config.access)) return;            // §4.1 access gate
  //     const reply = await thinkViaParent(event);                // M3 IPC
  //     await adapter.send(buildReply(event, reply));             // §4.2 outbound
  //   });
  void FeishuAdapter; // keep import live until M2 wires it
  void loadFeishuChannelConfig;
  throw new Error("startFeishuBridge: pending M2 (adapter + WSClient wiring)");
}

export { FeishuAdapter } from "./adapter.js";
export { loadFeishuChannelConfig } from "./config.js";
export type { FeishuAccessList, FeishuChannelConfig, FeishuChannelEnv } from "./config.js";
