import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type {
  SideThreadExecutionPort,
  SideThreadRuntimeEvent,
} from "./side-thread.js";

const suffix = randomUUID().replace(/-/g, "");
const dbPath = `/tmp/anet-side-thread-http-${suffix}.db`;
const ownerToken = `utok_${suffix}`;
const otherToken = `utok_other_${suffix}`;
const nodeToken = `ntok_${suffix}`;
let hub: any;
let db: any;
let detachPort: () => void = () => {};
let base = "";

class HttpFakePort implements SideThreadExecutionPort {
  listeners = new Set<(event: SideThreadRuntimeEvent) => void>();
  capability() {
    return {
      supported: true,
      mode: "native-exact-fork" as const,
      runtime: "codex",
      runtimeVersion: "0.148.0",
      topology: "owned-stdio",
      evidenceRevision: "reviewed",
      exactBoundary: { through: true, before: true },
    };
  }
  async fork(input: any) {
    return { threadId: `derived_${input.sideChatId}` };
  }
  async start(input: any) {
    return { turnId: `turn_${input.attemptId}` };
  }
  async cancel() {}
  async archive() {}
  async purge() {}
  async bringBack() {
    return { destinationTurnId: "destination_turn" };
  }
  subscribe(listener: (event: SideThreadRuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function headers(token = ownerToken) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.COMMHUB_DB = dbPath;
  process.env.COMMHUB_ENABLE_SIDE_THREADS = "1";
  delete process.env.DATABASE_URL;
  const dbModule = await import("./db.js");
  db = dbModule.db;
  db.run(
    "INSERT INTO users (user_id,username,password_hash,role) VALUES ('usr_owner','owner','x','user')",
  );
  db.run(
    "INSERT INTO users (user_id,username,password_hash,role) VALUES ('usr_other','other','x','user')",
  );
  db.run(
    "INSERT INTO networks (network_id,network_name,owner_id) VALUES ('net_a','A','usr_owner')",
  );
  db.run(
    "INSERT INTO network_members (network_id,user_id,role) VALUES ('net_a','usr_owner','owner')",
  );
  db.run(
    "INSERT INTO network_members (network_id,user_id,role) VALUES ('net_a','usr_other','member')",
  );
  db.run(
    "INSERT INTO nodes (node_id,node_name,alias,network_id,owner_user_id) VALUES ('node_a','node-a','node-a','net_a','usr_owner')",
  );
  db.run(
    "INSERT INTO nodes (node_id,node_name,alias,network_id,owner_user_id) VALUES ('node_b','node-b','node-b','net_a','usr_owner')",
  );
  db.run(
    "INSERT INTO api_tokens (token_id,token_hash,user_id,name,scope) VALUES ('tok_owner',?1,'usr_owner','owner','user')",
    [hash(ownerToken)],
  );
  db.run(
    "INSERT INTO api_tokens (token_id,token_hash,user_id,name,scope) VALUES ('tok_other',?1,'usr_other','other','user')",
    [hash(otherToken)],
  );
  db.run(
    "INSERT INTO api_tokens (token_id,token_hash,user_id,network_id,name,scope,bound_node_id) VALUES ('tok_node',?1,'usr_owner','net_a','node:node-a','network','node_a')",
    [hash(nodeToken)],
  );
  const serverModule = await import("./server.js");
  detachPort = serverModule.installSideThreadExecutionPort(new HttpFakePort());
  hub = serverModule.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => {
  detachPort();
  try {
    hub?.stop(true);
  } catch {}
  try {
    db?.close();
  } catch {}
});

describe("SideThread authenticated Hub HTTP", () => {
  let sideChatId = "";
  test("POST create and GET hydrate the complete question", async () => {
    const response = await fetch(`${base}/api/side-threads`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        requestKey: "http-create-0001",
        networkId: "net_a",
        nodeId: "node_a",
        sourceThreadId: "source_thread",
        boundary: { kind: "through", turnId: "source_turn" },
        prompt: "完整原问题\n第二行",
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    sideChatId = body.sideThread.sideThreadId;
    expect(body.sideThread).toMatchObject({
      requestKey: "http-create-0001",
      question: "完整原问题\n第二行",
      title: "完整原问题",
      state: "running",
    });
    const hydrated = await fetch(`${base}/api/side-threads/${sideChatId}`, {
      headers: headers(),
    });
    expect(((await hydrated.json()) as any).sideThread.question).toBe(
      "完整原问题\n第二行",
    );
    const listed = await fetch(
      `${base}/api/side-threads?network_id=net_a&limit=20`,
      { headers: headers() },
    );
    expect(await listed.json()).toMatchObject({
      count: 1,
      sideThreads: [{ question: "完整原问题\n第二行", bringBacks: [] }],
    });
  });

  test("cross-owner and query-token reads cannot recover the question", async () => {
    const cross = await fetch(`${base}/api/side-threads/${sideChatId}`, {
      headers: headers(otherToken),
    });
    expect(cross.status).toBe(404);
    expect(JSON.stringify(await cross.json())).not.toContain("完整原问题");
    const crossList = await fetch(`${base}/api/side-threads`, {
      headers: headers(otherToken),
    });
    const crossListBody = await crossList.json();
    expect(crossListBody).toMatchObject({ count: 0, sideThreads: [] });
    expect(JSON.stringify(crossListBody)).not.toContain("完整原问题");
    const queryOnly = await fetch(
      `${base}/api/side-threads/${sideChatId}?token=${ownerToken}`,
    );
    expect(queryOnly.status).toBe(401);
  });

  test("SSE replays metadata without question/result bodies", async () => {
    const response = await fetch(
      `${base}/api/side-threads/${sideChatId}/events`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    await reader.cancel();
    expect(text).toContain("side_thread");
    expect(text).toContain("sideThreadId");
    expect(text).not.toContain("sideChatId");
    expect(text).not.toContain("完整原问题");
  });

  test("node token is bound to its exact node", async () => {
    const response = await fetch(`${base}/api/side-threads`, {
      method: "POST",
      headers: headers(nodeToken),
      body: JSON.stringify({
        request_key: "http-create-node2",
        network_id: "net_a",
        node_id: "node_b",
        source_thread_id: "source_thread",
        boundary: { kind: "through", turn_id: "source_turn" },
        prompt: "must fail",
      }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "SIDE_THREAD_NOT_FOUND",
    });
  });

  test("removing the verified port yields typed unsupported, never a task row", async () => {
    detachPort();
    const before = db.get("SELECT COUNT(*) AS n FROM tasks").n;
    const response = await fetch(`${base}/api/side-threads`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        request_key: "http-no-port-01",
        network_id: "net_a",
        node_id: "node_a",
        source_thread_id: "source_thread",
        boundary: { kind: "through", turn_id: "source_turn" },
        prompt: "no fallback",
      }),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: "SIDE_THREAD_UNSUPPORTED",
    });
    expect(db.get("SELECT COUNT(*) AS n FROM tasks").n).toBe(before);
  });
});
