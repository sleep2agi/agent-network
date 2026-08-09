import { describe, expect, test } from "bun:test";
import type * as lark from "@larksuiteoapi/node-sdk";

import {
  FeishuAdapter,
  type FeishuEventDispatcherLike,
  type FeishuWsClientFactory,
  type FeishuWsClientLike,
} from "./adapter.js";
import type { IMChannelConfig } from "../types.js";
import { exitFeishuWorker } from "./worker-lifecycle.js";

type WsParams = Parameters<FeishuWsClientFactory>[0];

class FakeWsClient implements FeishuWsClientLike {
  started = 0;
  closed = 0;

  async start(): Promise<void> {
    this.started += 1;
    // Deliberately resolves before readiness, matching the SDK behavior that
    // caused #452. The adapter must wait for params.onReady instead.
  }

  close(): void {
    this.closed += 1;
  }
}

function config(appSecret = "secret-452"): IMChannelConfig {
  return {
    platform: "feishu",
    connectionName: "test-feishu",
    ingressMode: "socket",
    groupPolicy: "mention",
    ackPlaceholder: false,
    auditRaw: false,
    taskTimeoutMs: 1_000,
    platformConfig: {
      appId: "app-452",
      appSecret,
      access: { allowFrom: [], allowChats: [] },
      groupPolicy: "mention",
      ackPlaceholder: false,
      auditRaw: false,
      taskTimeoutMs: 1_000,
      outboundRender: "plain",
      channelDir: "/tmp/test452-channel",
    },
  };
}

function harness(options: {
  timeoutMs?: number;
  terminal?: (error: Error) => void;
} = {}) {
  let params: WsParams | undefined;
  let inbound: ((rawEvent: unknown) => Promise<unknown>) | undefined;
  const ws = new FakeWsClient();
  const adapter = new FeishuAdapter({
    createClient: () =>
      ({ request: async () => ({ bot: { open_id: "bot-452" } }) }) as unknown as lark.Client,
    createWsClient: (input) => {
      params = input;
      return ws;
    },
    createEventDispatcher: () => ({
      register: (handlers) => {
        inbound = handlers["im.message.receive_v1"];
      },
    }) satisfies FeishuEventDispatcherLike,
    wsReadyTimeoutMs: options.timeoutMs ?? 100,
    onTerminalError: options.terminal,
  });
  return {
    adapter,
    ws,
    get params() { return params; },
    get inbound() { return inbound; },
  };
}

const onEvent = async (): Promise<void> => {};

describe("FeishuAdapter WS lifecycle", () => {
  test("SDK start resolution is not readiness; missing onReady times out fail-closed", async () => {
    const h = harness({ timeoutMs: 15 });
    await h.adapter.init(config());

    await expect(h.adapter.start(onEvent)).rejects.toThrow("did not become ready");
    expect(h.ws.started).toBe(1);
    expect(h.ws.closed).toBe(1);
    expect(h.adapter.health().connected).toBe(false);
  });

  test("onReady is the only initial online authority", async () => {
    const h = harness();
    await h.adapter.init(config());
    const starting = h.adapter.start(onEvent);
    await Bun.sleep(1);
    expect(h.adapter.health().connected).toBe(false);

    h.params?.onReady?.();
    await starting;
    expect(h.adapter.health()).toMatchObject({ connected: true, lastError: null });
  });

  test("initial onError rejects and scrubs credentials", async () => {
    const terminal: Error[] = [];
    const h = harness({ terminal: (error) => terminal.push(error) });
    await h.adapter.init(config("do-not-log-me"));
    const starting = h.adapter.start(onEvent);
    await Bun.sleep(1);
    h.params?.onError?.(new Error("bad app-452 / do-not-log-me\ncredential"));

    await expect(starting).rejects.toThrow("bad [redacted] / [redacted] credential");
    expect(h.adapter.health().connected).toBe(false);
    expect(h.adapter.health().lastError).not.toContain("do-not-log-me");
    expect(terminal).toHaveLength(0);
  });

  test("initial onError scrubs arbitrary Lark access-token shapes", async () => {
    const h = harness();
    await h.adapter.init(config());
    const starting = h.adapter.start(onEvent);
    await Bun.sleep(1);
    h.params?.onError?.(new Error(
      "Bearer bearer-token-618 t-tenant-token-618 u-user-token-618 cli_other-app-618",
    ));

    await expect(starting).rejects.toThrow(
      "Bearer [redacted] [redacted] [redacted] [redacted]",
    );
    const lastError = h.adapter.health().lastError ?? "";
    for (const secret of [
      "bearer-token-618",
      "t-tenant-token-618",
      "u-user-token-618",
      "cli_other-app-618",
    ]) {
      expect(lastError).not.toContain(secret);
    }
  });

  test("spurious reconnect before first ready cannot mark health connected", async () => {
    const h = harness({ timeoutMs: 15 });
    await h.adapter.init(config());
    const starting = h.adapter.start(onEvent);
    await Bun.sleep(1);

    h.params?.onReconnected?.();
    expect(h.adapter.health().connected).toBe(false);
    await expect(starting).rejects.toThrow("did not become ready");
    expect(h.adapter.health().connected).toBe(false);
  });

  test("inbound handler errors use the same token scrub before health", async () => {
    const h = harness();
    const inboundConfig = config();
    (inboundConfig.platformConfig as { access: { allowFrom: string[] } }).access.allowFrom = ["ou_test"];
    await h.adapter.init(inboundConfig);
    const starting = h.adapter.start(async () => {
      throw new Error("inbound t-inbound-token-618 Bearer inbound-bearer-618");
    });
    await Bun.sleep(1);
    h.params?.onReady?.();
    await starting;

    await h.inbound?.({
      sender: { sender_id: { open_id: "ou_test" }, tenant_key: "tenant" },
      message: {
        message_id: "om_test618",
        message_type: "text",
        content: '{"text":"hello"}',
        chat_type: "p2p",
        chat_id: "oc_test618",
        mentions: [],
      },
    });

    expect(h.adapter.health().lastError).toBe(
      "inbound [redacted] Bearer [redacted]",
    );
  });

  test("reconnecting lowers health and reconnected restores it", async () => {
    const h = harness();
    await h.adapter.init(config());
    const starting = h.adapter.start(onEvent);
    await Bun.sleep(1);
    h.params?.onReady?.();
    await starting;

    h.params?.onReconnecting?.();
    expect(h.adapter.health().connected).toBe(false);
    h.params?.onReconnected?.();
    expect(h.adapter.health().connected).toBe(true);
  });

  test("terminal error after ready lowers health and notifies worker owner once", async () => {
    const terminal: Error[] = [];
    const h = harness({ terminal: (error) => terminal.push(error) });
    await h.adapter.init(config());
    const starting = h.adapter.start(onEvent);
    await Bun.sleep(1);
    h.params?.onReady?.();
    await starting;

    h.params?.onError?.(new Error("retries exhausted"));
    h.params?.onError?.(new Error("duplicate terminal callback"));
    h.params?.onReconnected?.();
    expect(h.adapter.health()).toMatchObject({
      connected: false,
      lastError: "retries exhausted",
    });
    expect(terminal.map((error) => error.message)).toEqual(["retries exhausted"]);
  });

  test("stop closes the public SDK client and invalidates late callbacks", async () => {
    const h = harness();
    await h.adapter.init(config());
    const starting = h.adapter.start(onEvent);
    await Bun.sleep(1);
    h.params?.onReady?.();
    await starting;
    await h.adapter.stop();
    expect(h.ws.closed).toBe(1);
    h.params?.onReconnected?.();
    expect(h.adapter.health().connected).toBe(false);
  });
});

test("worker terminal owner logs safely and exits non-zero", () => {
  const writes: string[] = [];
  const exits: number[] = [];
  exitFeishuWorker(new Error("retries exhausted"), {
    stderr: { write: (message) => writes.push(message) },
    exit: (code) => exits.push(code),
  });
  expect(writes).toEqual([
    "[feishu:worker] connection failed after ready: retries exhausted\n",
  ]);
  expect(exits).toEqual([1]);
});
