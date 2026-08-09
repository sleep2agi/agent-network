import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const dir = mkdtempSync(join(tmpdir(), "anet-skillhub-"));
let server: any;
let base = "";
let ownerToken = "";
let nodeToken = "";
let foreignToken = "";
let networkId = "";

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const dataLines = raw.split("\n").filter(x => x.startsWith("data:"));
  const payload = dataLines.length
    ? JSON.parse(dataLines.at(-1)!.slice(5).trim())
    : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(dir, "hub.db");
  const owner = register(`skill_owner_${Date.now()}`, "SkillHubOwner123!", undefined, "seed");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!; networkId = owner.network_id!;
  const ownerId = db.get<{ user_id: string }>("SELECT owner_id AS user_id FROM networks WHERE network_id = ?1", networkId)!.user_id;
  const node = createNetworkTokenForNode(ownerId, networkId, "skill-writer");
  expect(node.ok).toBe(true); nodeToken = node.token!;
  const foreign = register(`skill_foreign_${Date.now()}`, "SkillHubForeign123!", undefined, "seed");
  expect(foreign.ok).toBe(true); foreignToken = foreign.token!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => { try { server?.stop?.(true); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe("SkillHub real Hub + SQLite", () => {
  let skillId = "";
  test("node submit is token-attributed, pending and immutable/idempotent", async () => {
    const input = { network_id: networkId, slug: "incident-handoff", name: "Incident handoff", version: "1.0.0", description: "handoff", content: "# Incident handoff\n\nVerify facts." };
    const first = await tool(nodeToken, "submit_skill", { ...input, source_alias: "forged-admin" });
    expect(first.ok).toBe(true); expect(first.status).toBe("pending"); expect(first.source_alias).toBe("skill-writer"); skillId = first.skill_id;
    const retry = await tool(nodeToken, "submit_skill", input);
    expect(retry.idempotent).toBe(true); expect(retry.skill_id).toBe(skillId);
    const conflict = await tool(nodeToken, "submit_skill", { ...input, content: "changed" });
    expect(conflict.error).toBe("skill_version_conflict");
    const raceBase = { ...input, slug: "concurrent-version", version: "2.0.0" };
    const raced = await Promise.all([
      tool(nodeToken, "submit_skill", { ...raceBase, content: "winner-a" }),
      tool(nodeToken, "submit_skill", { ...raceBase, content: "winner-b" }),
    ]);
    expect(raced.filter(x => x.ok).length).toBe(1);
    expect(raced.filter(x => x.error === "skill_version_conflict").length).toBe(1);
  });

  test("pending is reviewer-only; owner publishes; published becomes visible", async () => {
    const nodeList = await tool(nodeToken, "list_skills", { network_id: networkId, include_pending: true });
    expect(nodeList.skills).toHaveLength(0);
    expect((await tool(nodeToken, "get_skill", { network_id: networkId, skill_id: skillId })).error).toBe("skill_not_found");
    const ownerList = await tool(ownerToken, "list_skills", { network_id: networkId, include_pending: true });
    expect(ownerList.reviewer).toBe(true); expect(ownerList.skills.map((x: any) => x.skill_id)).toContain(skillId);
    expect((await tool(ownerToken, "get_skill", { network_id: networkId, skill_id: skillId })).skill.content).toContain("Verify facts");
    const reviewed = await tool(ownerToken, "review_skill", { network_id: networkId, skill_id: skillId, decision: "published" });
    expect(reviewed.status).toBe("published");
    const published = await tool(nodeToken, "list_skills", { network_id: networkId });
    expect(published.skills.map((x: any) => x.skill_id)).toContain(skillId);
    expect((await tool(nodeToken, "get_skill", { network_id: networkId, skill_id: skillId })).skill.skill_id).toBe(skillId);
    const detail = (await tool(nodeToken, "get_skill", { network_id: networkId, skill_id: skillId })).skill;
    expect(detail.created_by_user).toBeUndefined(); expect(detail.reviewed_by_user).toBeUndefined(); expect(detail.content_hash).toBeUndefined();
  });

  test("foreign user cannot read or review another network", async () => {
    expect((await tool(foreignToken, "list_skills", { network_id: networkId })).ok).toBe(false);
    const review = await tool(foreignToken, "review_skill", { network_id: networkId, skill_id: skillId, decision: "rejected" });
    expect(review.ok).toBe(false);
  });
});
