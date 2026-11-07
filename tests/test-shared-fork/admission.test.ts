import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setup } from "./fixture";
import { createSessionSourceEvidenceReader } from "../../agent-node/src/runtime/session-source-evidence";
import { isSourceReadEvidence, type SourceReadChallenge } from "../../contracts/session-source-evidence";
import { acceptsSharedVersion, isOwnedTestBuild, TEST_BUILD_VERSION, observeSharedTestBuild } from "../../agent-node/src/runtime/opencode-copresence/v2-test-build-identity";
import { catalogSupportsVariants } from "../../agent-node/src/runtime/opencode-copresence/v2-model-selection";

test("actual created shared source: exact fork evidence authority/version/session/catalog controls, no fork writes", async () => {
  const x = await setup();
  try {
    const reader = createSessionSourceEvidenceReader({ networkId: x.net, daemonId: x.daemonId, daemonWorkDir: x.f.daemonDir, home: x.f.home });
    const q = (): SourceReadChallenge => ({ request_id: `srcq_${randomUUID()}`, challenge: "a".repeat(43), network_id: x.net, daemon_node_id: x.daemonId,
      source_node_id: x.sourceId, alias: "created-shared-source", session_id: x.sessionId, expires_at: Date.now() + 15000,
      user_id: x.human.user!.user_id, requester_token_id: "synthetic_token_id", mode: "fork_independent" });
    const positive = await reader.read(q()); expect(positive.ok).toBe(true); if (!positive.ok) throw Error("actual_shared_source_admission_failed");
    expect(positive.evidence.api_version).toBe(TEST_BUILD_VERSION); expect(isSourceReadEvidence(positive.evidence)).toBe(true);
    expect(isSourceReadEvidence({ ...positive.evidence, api_version: "2.0.22" })).toBe(true); // legacy wire parsing, not fake-stock native admission
    for (const version of ["2.0.23", "2.0.22-anet-test.unknown", "2.0.22-anet-test.29040e2-extra", ""]) {
      expect(isSourceReadEvidence({ ...positive.evidence, api_version: version })).toBe(false);
      expect(await acceptsSharedVersion(x.f.url, { version, pid: x.f.native.pid }, true)).toBe(false);
    }
    expect(await acceptsSharedVersion(x.f.url, await x.f.api("/api/info"), false)).toBe(false);
    expect(await isOwnedTestBuild({ version: TEST_BUILD_VERSION, serverPid: x.f.native.pid!, childPid: x.f.native.pid!, hashExecutable: async () => "0".repeat(64) })).toBe(false);
    const counterfeit = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ version: TEST_BUILD_VERSION, pid: process.pid }) });
    try { expect(await observeSharedTestBuild(`http://127.0.0.1:${counterfeit.port}`, TEST_BUILD_VERSION)).toBeUndefined(); } finally { counterfeit.stop(true); }
    const change = async (path: string, alter: (v: any) => void) => {
      const before = readFileSync(path, "utf8"), v = JSON.parse(before); alter(v); writeFileSync(path, JSON.stringify(v));
      try { expect((await reader.read(q())).ok).toBe(false); } finally { writeFileSync(path, before); }
    };
    await change(x.f.policyPath, v => { delete v.grants[0].test_only_shared_variant; });
    await change(x.f.policyPath, v => { v.grants[0].network_id = "other_network"; });
    await change(x.f.policyPath, v => { v.grants[0].directories = [x.f.home]; });
    await change(x.profilePath, v => { delete v.sharedVariantAuthority; });
    await change(x.profilePath, v => { v.sharedVariantAuthority.daemonWorkDir = x.f.home; });
    await change(x.profilePath, v => { v.sourceDelivery.expected_version = "2.0.22"; });
    expect((await reader.read({ ...q(), session_id: "ses_wrongSession" })).ok).toBe(false);
    expect((await reader.read({ ...q(), daemon_node_id: "other_daemon" })).ok).toBe(false);
    expect((await reader.read({ ...q(), network_id: "other_network" })).ok).toBe(false);
    const catalog = await x.f.api("/api/model"), selected = { providerID: "fixture", id: "model" };
    expect(catalogSupportsVariants(catalog, x.f.project, selected)).toBe(true);
    expect(catalogSupportsVariants({ ...catalog, location: { directory: x.f.home } }, x.f.project, selected)).toBe(false);
    expect(catalogSupportsVariants({ ...catalog, data: catalog.data.map((m: any) => ({ ...m, variants: undefined })) }, x.f.project, selected)).toBe(false);
    expect(await reader.recheck(positive.evidence.lease_id)).toBe(true);
    await change(x.f.policyPath, v => { v.grants[0].test_only_shared_variant = false; });
    expect(x.forkStatuses).toEqual([]); expect(x.nativeWrites.filter(p => p.includes("/fork"))).toEqual([]);
    console.log("SHARED_FORK_ADMISSION", JSON.stringify({ actualCreatedSource: x.sourceId, version: positive.evidence.api_version, directedAuthorityNegatives: true, unknownVersionRejected: true, wrongHashHelperRejected: true, counterfeitListenerRejected: true, zeroForkWrites: true }));
  } finally { await x.stop(); }
}, 150000);
