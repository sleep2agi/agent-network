import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerScheduleConsumer } from "./owner-schedule-consumer.js";
import type { CrontabAdapter } from "./owner-schedule-control.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anet-owner-consumer-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, "{}\n", { mode: 0o600 });
  const tail = " /usr/bin/grok-news --latest";
  const commandHash = createHash("sha256").update(tail).digest("hex");
  let current = [
    `# ANET-MANAGED-SCHEDULE id=news-pull revision=7 command_sha256=${commandHash}`,
    `0 */6 * * *${tail}`,
    "# ANET-MANAGED-SCHEDULE-END id=news-pull",
    "",
  ].join("\n");
  let installs = 0;
  const adapter: CrontabAdapter = { read: () => current, install: (value) => { installs += 1; current = value; } };
  return { root, configPath, adapter, current: () => current, installs: () => installs };
}

function delivered(nodeId = "n_owner_schedule") {
  return {
    ok: true,
    intent: {
      intent_id: "sei_12345678-1234-1234-1234-123456789abc",
      node_id: nodeId,
      schedule_id: "news-pull",
      base_revision: 7,
      patch: { cron: "0 */12 * * *", enabled: false },
      status: "delivered",
    },
  };
}

describe("process-gated owner schedule consumer", () => {
  test("disabled process registers no poll and makes zero network/host calls", async () => {
    const f = fixture();
    let fetches = 0;
    const consumer = createOwnerScheduleConsumer({
      enabled: false,
      hubUrl: "http://hub.invalid",
      token: "not-even-a-token",
      nodeId: "not-even-a-node",
      configPath: f.configPath,
      fetchImpl: (async () => { fetches += 1; throw new Error("must not run"); }) as any,
      crontabAdapter: f.adapter,
    });
    await consumer.trigger();
    expect(consumer.enabled).toBe(false);
    expect(fetches).toBe(0);
    expect(f.installs()).toBe(0);
  });

  test("exact node intent applies once, ACKs, and deletes journal only after ACK", async () => {
    const f = fixture();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/pending")) return Response.json(delivered());
      return Response.json({ ok: true });
    }) as typeof fetch;
    const consumer = createOwnerScheduleConsumer({
      enabled: true, hubUrl: "http://hub.invalid", token: "ntok_test", nodeId: "n_owner_schedule",
      configPath: f.configPath, fetchImpl, crontabAdapter: f.adapter, pollIntervalMs: 60_000,
    });
    await consumer.trigger();
    consumer.stop();
    expect(f.installs()).toBe(1);
    expect(f.current()).toContain("revision=8");
    const ack = requests.find((request) => request.url.endsWith("/ack"))!;
    expect(JSON.parse(String(ack.init?.body))).toEqual({ status: "applied", result_revision: 8 });
    expect(existsSync(join(f.root, ".external-schedule-edit-journal.json"))).toBe(false);
  });

  test("foreign-node intent and invalid authority shape never reach crontab", async () => {
    const f = fixture();
    const fetchImpl = (async () => Response.json(delivered("n_foreign"))) as typeof fetch;
    const consumer = createOwnerScheduleConsumer({
      enabled: true, hubUrl: "http://hub.invalid", token: "ntok_test", nodeId: "n_owner_schedule",
      configPath: f.configPath, fetchImpl, crontabAdapter: f.adapter, pollIntervalMs: 60_000,
    });
    await consumer.trigger();
    consumer.stop();
    expect(f.installs()).toBe(0);
    expect(f.current()).toContain("revision=7");
  });

  test("lost ACK keeps journal; same delivered intent recovers without a second install", async () => {
    const f = fixture();
    let ackCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pending")) return Response.json(delivered());
      ackCalls += 1;
      return ackCalls === 1 ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true });
    }) as typeof fetch;
    const consumer = createOwnerScheduleConsumer({
      enabled: true, hubUrl: "http://hub.invalid", token: "ntok_test", nodeId: "n_owner_schedule",
      configPath: f.configPath, fetchImpl, crontabAdapter: f.adapter, pollIntervalMs: 60_000,
    });
    await consumer.trigger();
    expect(f.installs()).toBe(1);
    expect(existsSync(join(f.root, ".external-schedule-edit-journal.json"))).toBe(true);
    await consumer.trigger();
    consumer.stop();
    expect(f.installs()).toBe(1);
    expect(ackCalls).toBe(2);
    expect(existsSync(join(f.root, ".external-schedule-edit-journal.json"))).toBe(false);
  });
});
