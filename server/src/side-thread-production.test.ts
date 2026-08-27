import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteAdapter } from "./db-adapter";
import { createProductionSideThreadTransport } from "./side-thread-production";

const roots: string[] = [];
const priorUploads = process.env.COMMHUB_UPLOADS_DIR;
afterEach(() => {
  if (priorUploads === undefined) delete process.env.COMMHUB_UPLOADS_DIR;
  else process.env.COMMHUB_UPLOADS_DIR = priorUploads;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production Hub SideThread wiring", () => {
  test("advertises only an exact node snapshot and serves a short-lived node-bound grant", async () => {
    const root = mkdtempSync(join(tmpdir(), "side-hub-prod-")); roots.push(root);
    process.env.COMMHUB_UPLOADS_DIR = root;
    const db = new SQLiteAdapter(new Database(":memory:"));
    db.exec("CREATE TABLE nodes(node_id TEXT PRIMARY KEY, network_id TEXT, config_snapshot TEXT)");
    db.run("INSERT INTO nodes VALUES (?1,?2,?3)", ["node-1", "net-1", JSON.stringify({ side_thread_capability: {
      supported: true, runtime: "codex-app-server", runtimeVersion: "0.148.0", topology: "owned-stdio",
      evidenceRevision: "test1190-wire-v2", mode: "native-exact-fork", exactBoundary: { through: true, before: false },
    } })]);
    let now = 1_000;
    const transport = createProductionSideThreadTransport(db, () => now, 0);
    expect(transport.port.capability("node-1")).toMatchObject({ supported: true, exactBoundary: { before: false } });
    expect(transport.port.capability("missing")).toMatchObject({ supported: false, reason: "runtime" });

    const fileId = "file12345678"; const bytes = Buffer.from("image bytes"); const bucket = "2026-08-26";
    mkdirSync(join(root, ".index"), { recursive: true }); mkdirSync(join(root, bucket), { recursive: true });
    writeFileSync(join(root, bucket, `${fileId}.png`), bytes);
    writeFileSync(join(root, ".index", `${fileId}.json`), JSON.stringify({
      file_id: fileId, date_bucket: bucket, ext: ".png", name: "x.png", mime: "image/png",
      size: bytes.length, owner_id: "user-1", network_id: "net-1", uploaded_at: new Date().toISOString(),
    }));
    await transport.port.start({
      operationId: "op-start", requestKey: "rk-start", sideChatId: "side-1", attemptId: "attempt-1",
      nodeId: "node-1", threadId: "derived-1", prompt: "read it",
      attachments: [{ fileId, mediaType: "image/png", size: bytes.length }],
    }).catch(() => {});
    const command = transport.store.claim({ tokenId: "token-1", networkId: "net-1", nodeId: "node-1" }) as any;
    const grant = command.payload.attachments[0];
    expect(grant).toMatchObject({ fileId, mediaType: "image/png", size: bytes.length });
    expect(grant.sha256).toMatch(/^[a-f0-9]{64}$/);
    const url = new URL(`http://hub/api/side-thread/attachment-grants/${grant.grantId}`);
    const foreign = await transport.attachment(new Request(url), url, { tokenId: "foreign", networkId: "net-1", nodeId: "node-2" });
    expect(foreign?.status).toBe(404);
    const response = await transport.attachment(new Request(url), url, { tokenId: "token-1", networkId: "net-1", nodeId: "node-1" });
    expect(response?.status).toBe(200); expect(Buffer.from(await response!.arrayBuffer())).toEqual(bytes);
    now += 5 * 60_000 + 1;
    expect((await transport.attachment(new Request(url), url, { tokenId: "token-1", networkId: "net-1", nodeId: "node-1" }))?.status).toBe(404);
    await transport.port.start({
      operationId: "op-start-2", requestKey: "rk-start-2", sideChatId: "side-2", attemptId: "attempt-2",
      nodeId: "node-1", threadId: "derived-2", prompt: "read it again",
      attachments: [{ fileId, mediaType: "image/png", size: bytes.length }],
    }).catch(() => {});
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM side_thread_attachment_grants")?.count).toBe(1);
  });

  test("rejects forged capability shapes instead of widening the allowlist", () => {
    const db = new SQLiteAdapter(new Database(":memory:"));
    db.exec("CREATE TABLE nodes(node_id TEXT PRIMARY KEY, network_id TEXT, config_snapshot TEXT)");
    db.run("INSERT INTO nodes VALUES (?1,?2,?3)", ["node-1", "net-1", JSON.stringify({ side_thread_capability: {
      supported: true, runtime: "codex-app-server", runtimeVersion: "latest", topology: "owned-stdio",
      evidenceRevision: "test1190-wire-v2", mode: "native-exact-fork", exactBoundary: { through: true, before: true },
    } })]);
    expect(createProductionSideThreadTransport(db).port.capability("node-1")).toMatchObject({ supported: false });
  });
});
