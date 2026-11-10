import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setup, until } from "./fixture";
import { SOURCE_FORK_ROOT as F } from "../../contracts/session-source-transport";
import { TEST_BUILD_VERSION } from "../../agent-node/src/runtime/opencode-copresence/v2-test-build-identity";

test("human managed fork from actual created/materialized shared source -> production worker -> native once -> paired exact child -> SSE high/clear", async () => {
  const x = await setup();
  try {
    const sourceContext = await x.f.api(`/api/session/${x.sessionId}/context`), sourceInfo = await x.f.api(`/api/session/${x.sessionId}`), serverBefore = await x.f.api("/api/info");
    const sourceHealth = JSON.parse(readFileSync(join(x.f.project, ".anet", "nodes", "created-shared-source", "source-resume-health.json"), "utf8"));
    expect(JSON.stringify(sourceContext)).toContain("Local synthetic seed response."); expect(serverBefore.version).toBe(TEST_BUILD_VERSION);
    const intent = { network_id: x.net, source_node_id: x.sourceId, session_id: x.sessionId, mode: "fork_independent", child_name: "actual-shared-fork", intent_id: randomUUID() };
    const receipt = await x.api(F, intent);
    await x.worker.tick();
    const result = await until("fork_terminal_timeout", async () => {
      await x.worker.tick(); const r = await x.api(`${F}/${receipt.request_id}?network_id=${x.net}`);
      if (["refused", "unknown_rotation_required"].includes(r.status)) {
        console.log("FORK_FIRST_FAILURE", JSON.stringify({ status: r.status, nativeForkStatuses: x.forkStatuses, registration: x.registerStatuses,
          launches: existsSync(x.launches) ? readFileSync(x.launches, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [],
          fixed: existsSync(x.diagnostic) ? readFileSync(x.diagnostic, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [] }));
        throw Error(`fork_${r.status}`);
      } return r.status === "registration_confirmed" && r;
    });
    expect(x.forkStatuses).toEqual([200]); expect(x.registerStatuses).toEqual([200]);
    const row = x.db.get("SELECT * FROM session_source_transports WHERE request_id=?1", receipt.request_id), id = row.child_session_id, node = row.child_node_id;
    expect(id).not.toBe(x.sessionId); expect(node).not.toBe(x.sourceId);
    const childDir = join(x.f.project, ".anet", "nodes", "actual-shared-fork"), profile = JSON.parse(readFileSync(join(childDir, "config.json"), "utf8")), health = JSON.parse(readFileSync(join(childDir, "source-resume-health.json"), "utf8"));
    expect(profile.sessionId).toBe(id); expect(profile.sourceDelivery.expected_version).toBe(TEST_BUILD_VERSION); expect(health.version).toBe(TEST_BUILD_VERSION);
    expect(profile.sharedVariantAuthority).toEqual(JSON.parse(readFileSync(x.profilePath, "utf8")).sharedVariantAuthority);
    expect(x.evidenceVersions).toEqual([TEST_BUILD_VERSION]);
    // Native materialized fork context, not a fabricated empty Session.
    const forkContext = await x.f.api(`/api/session/${id}/context`); expect(JSON.stringify(forkContext)).toContain("Local synthetic seed response.");
    let c = await x.capable(node); expect(c.opencode_variant_config_capable).toBe(true);
    const patch = async (variant: string | null) => {
      // Terminal config ACK is not a promise that a concurrent heartbeat's
      // capability observation has settled. Refresh real admission before each
      // distinct intent; never retry a submitted update or force capability.
      c = await x.capable(node);
      const r = await fetch(x.hubUrl + "/mcp", { method: "POST", headers: { authorization: `Bearer ${x.human.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_node_config", arguments: { node_id: node, network_id: x.net, base_revision: c.config_revision, patch: { modelVariant: variant } } } }) });
      const text = await r.text(), line = text.split("\n").find(l => l.startsWith("data: ")), envelope = JSON.parse(line ? line.slice(6) : text), accepted = JSON.parse(envelope.result.content[0].text);
      if (!accepted.ok) console.log("FORK_CONFIG_REFUSAL", JSON.stringify({ variant, error: accepted.error, field: accepted.field, baseRevision: c.config_revision, advertisedCapable: c.opencode_variant_config_capable }));
      expect(accepted.ok).toBe(true);
      c = await until("fork_config_ack_timeout", async () => { const v = await x.api(`/api/nodes/${node}/config?network_id=${x.net}`); return v.last_update?.update_id === accepted.update_id && v.last_update.terminal && v; });
      expect(c.last_update.status).toBe("applied"); return c.last_update.status;
    };
    const high = await patch("high"); expect((await x.f.api(`/api/session/${id}`)).data.model.variant).toBe("high");
    const clear = await patch(null); expect((await x.f.api(`/api/session/${id}`)).data.model.variant).toBe("default");
    const tokenCount = x.db.get("SELECT COUNT(*) n FROM api_tokens").n, launchCount = readFileSync(x.launches, "utf8").trim().split("\n").length;
    expect((await x.api(F, intent)).request_id).toBe(receipt.request_id); await x.worker.tick();
    expect(x.forkStatuses).toEqual([200]); expect(x.db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokenCount);
    expect(readFileSync(x.launches, "utf8").trim().split("\n")).toHaveLength(launchCount); expect(launchCount).toBe(2);
    expect(await x.f.api(`/api/session/${x.sessionId}/context`)).toEqual(sourceContext); expect(await x.f.api(`/api/session/${x.sessionId}`)).toEqual(sourceInfo);
    expect((await x.f.api("/api/info")).pid).toBe(serverBefore.pid);
    const writes = readFileSync(x.audit, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(a => a.method !== "GET");
    expect(writes).toEqual([{ method: "POST", path: `/api/session/${id}/model` }, { method: "POST", path: `/api/session/${id}/model` }]);
    await x.stopChild("actual-shared-fork");
    await until("fork_child_stop_timeout", async () => { try { process.kill(health.pid, 0); return false; } catch { return true; } });
    expect(() => process.kill(sourceHealth.pid, 0)).not.toThrow(); expect((await x.f.api("/api/info")).pid).toBe(serverBefore.pid);
    expect(await x.f.api(`/api/session/${x.sessionId}/context`)).toEqual(sourceContext); expect((await x.capable(x.sourceId)).opencode_variant_config_capable).toBe(true);
    console.log("SHARED_MANAGED_FORK_ACCEPTANCE", JSON.stringify({ seedRequest: x.seedRequest, sourceNode: x.sourceId, sourceSession: x.sessionId, request: receipt.request_id,
      childNode: node, childSession: id, version: profile.sourceDelivery.expected_version, forkHttpStatuses: x.forkStatuses, registrationAck: x.registerStatuses,
      materializedContext: true, high, clear, childSetterAttempts: writes.length, sameIntentNoForkMintLaunch: true, sourceContextPreserved: true,
      serverPidPreserved: true, forkChildOnlyStop: true, sourceBridgePreserved: true, providerCalls: x.f.providerCalls(), overlay: false }));
  } catch (error) {
    console.log("FORK_TRANSPORT_TRACE", JSON.stringify({ trace: x.trace, nativeForkStatuses: x.forkStatuses, registration: x.registerStatuses })); throw error;
  } finally { await x.stop(); }
}, 150000);
