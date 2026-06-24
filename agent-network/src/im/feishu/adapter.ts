/**
 * RFC-020 §3.1 — Feishu (Lark) adapter for the IM compatibility layer.
 *
 * Uses `@larksuiteoapi/node-sdk` in WebSocket long-connection mode (WSClient).
 * No public IP / no domain verification / no webhook signature decryption —
 * the three biggest 飞书 接入 risks all live in the HTTP event-callback path,
 * not in WSClient mode.
 *
 * Milestones:
 *   M1 (this file): contract scaffold — implements IMAdapter signature with
 *                   TODO stubs so subsequent milestones can fill behavior.
 *   M2:  WSClient init + EventDispatcher for `im.message.receive_v1` +
 *        normalize raw events to NormalizedIMEvent + access whitelist gate.
 *   M3:  outbound `im.message.create` (text), edit support (≤20/msg), think()
 *        bridge handoff.
 *   M5:  image upload/download (`im.image.create` / `im.messageResource.get`).
 */
import type {
  IMAdapter,
  IMAdapterHealth,
  IMChannelConfig,
  IMConversationRef,
  IMIngressMode,
  NormalizedIMEvent,
  NormalizedIMMessage,
} from "../types.js";
import type { FeishuChannelConfig } from "./config.js";

export class FeishuAdapter implements IMAdapter {
  readonly platform = "feishu";
  readonly ingressMode: IMIngressMode = "socket";

  private feishuConfig: FeishuChannelConfig | null = null;
  private health_: IMAdapterHealth = {
    connected: false,
    lastEventAt: null,
    lastError: null,
  };

  async init(_config: IMChannelConfig): Promise<void> {
    // M2: extract FeishuChannelConfig from _config.platformConfig
    // M2: const client = new lark.Client({ appId, appSecret, disableTokenCache: false })
    throw new Error("FeishuAdapter.init: pending M2 (WSClient wiring)");
  }

  async start(
    _onEvent: (event: NormalizedIMEvent) => Promise<void>,
  ): Promise<void> {
    // M2: const ws = new lark.WSClient({ appId, appSecret, loggerLevel: WARN })
    // M2: const dispatcher = new lark.EventDispatcher({}).register({
    //       "im.message.receive_v1": handler that normalizes → access-check → onEvent
    //     })
    // M2: await ws.start({ eventDispatcher: dispatcher })
    throw new Error("FeishuAdapter.start: pending M2 (WSClient + EventDispatcher)");
  }

  async stop(): Promise<void> {
    // M2: graceful WSClient teardown.
    this.health_ = { ...this.health_, connected: false };
  }

  async send(
    _message: NormalizedIMMessage,
  ): Promise<{ messageId: string }> {
    // M3: client.im.message.create({
    //       params: { receive_id_type: dm ? "open_id" : "chat_id" },
    //       data: { receive_id, msg_type: "text"|"image"|..., content: JSON.stringify({...}) }
    //     })
    throw new Error("FeishuAdapter.send: pending M3 (im.message.create wiring)");
  }

  async edit(
    _target: IMConversationRef,
    _messageId: string,
    _message: NormalizedIMMessage,
  ): Promise<void> {
    // M3+: client.im.message.update — Feishu supports edit up to 20 times per msg.
    // Used to promote the "⏳ 处理中…" placeholder into the final reply.
    throw new Error("FeishuAdapter.edit: pending M3+ (im.message.update wiring)");
  }

  health(): IMAdapterHealth {
    return { ...this.health_ };
  }
}
