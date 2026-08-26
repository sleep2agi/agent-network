import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db";
import { registerTools } from "./tools";

const NET = "net-os-user-status";
const ALIAS = "node-os-user-status";
const TOKEN_ID = "token-os-user-status";

async function connectClient() {
  const server = new McpServer({ name: "os-user-status-test", version: "1" });
  // A network-bound node token carries its enforced network and alias. The
  // transport fixture does not need to fabricate unrelated user membership
  // rows; network/alias binding is the authorization boundary under test.
  registerTools(server, "127.0.0.1", NET, null, ALIAS, true, TOKEN_ID);
  const client = new Client({ name: "os-user-status-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function report(client: Client, extra: Record<string, unknown> = {}) {
  return client.callTool({
    name: "report_status",
    arguments: { resume_id: "resume-os-user", alias: ALIAS, status: "idle", network_id: NET, ...extra },
  });
}

function toolJson(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("missing text tool result");
  return JSON.parse(first.text);
}

beforeEach(() => {
  db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]);
});

afterAll(() => {
  db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]);
});

describe("#1197 report_status OS user contract", () => {
  test("stores an explicit bounded OS user without deriving it from project_dir", async () => {
    const { client, server } = await connectClient();
    try {
      const result = await report(client, { os_user: "DOMAIN\\runner", project_dir: "/srv/not-the-user/project" });
      expect(result.isError).not.toBe(true);
      expect(db.get<{ os_user: string }>("SELECT os_user FROM sessions WHERE network_id = ?1 AND alias = ?2", NET, ALIAS)?.os_user)
        .toBe("DOMAIN\\runner");
      const status = await client.callTool({ name: "get_all_status", arguments: { filter_alias: ALIAS } });
      expect(toolJson(status).sessions).toEqual([
        expect.objectContaining({ alias: ALIAS, os_user: "DOMAIN\\runner", network_id: NET }),
      ]);
      await report(client, { os_user: null });
      expect(db.get<{ os_user: string | null }>("SELECT os_user FROM sessions WHERE network_id = ?1 AND alias = ?2", NET, ALIAS)?.os_user)
        .toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("legacy reporters that omit the field remain compatible and persist null", async () => {
    const { client, server } = await connectClient();
    try {
      const result = await report(client, { project_dir: "C:\\Users\\guessing-is-forbidden\\repo" });
      expect(result.isError).not.toBe(true);
      const row = db.get<{ os_user: string | null }>("SELECT os_user FROM sessions WHERE network_id = ?1 AND alias = ?2", NET, ALIAS);
      expect(row?.os_user).toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });

  test.each([
    ["control characters", "root\nforged"],
    ["surrounding whitespace", " root"],
    ["overlong value", "x".repeat(257)],
  ])("rejects %s before persistence", async (_case, os_user) => {
    const { client, server } = await connectClient();
    try {
      const result = await report(client, { os_user });
      expect(result.isError).toBe(true);
      expect(db.get("SELECT os_user FROM sessions WHERE network_id = ?1 AND alias = ?2", NET, ALIAS)).toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
