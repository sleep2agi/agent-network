import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { fixture, binary } from "./fixture";
import { openVettedOpenCodeCopresence } from "../../agent-node/src/runtime/opencode-copresence/runtime";
import { OPENCODE_V2_BACKEND } from "../../agent-node/src/runtime/opencode-backend";
import { acceptsSharedVersion, observeSharedTestBuild, TEST_BUILD_VERSION } from "../../agent-node/src/runtime/opencode-copresence/v2-test-build-identity";
import { acceptedOpencodeVersionsFor } from "../../agent-node/src/runtime/opencode-versions";

test("real shared controller: independent operator policy + exact listener identity; high/default/busy and zero-write negatives", async () => {
  const f = await fixture(); let session: any;
  const fetchOriginal = globalThis.fetch, postedPaths: string[] = []; let badCatalog = false, badInfo = false, badSession = false, badDefault = false, malformedModel = false;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.startsWith(f.url) && init?.method === "POST") postedPaths.push(new URL(url).pathname);
    const response = await fetchOriginal(input, init);
    if (badInfo && url === f.url + "/api/info") return Response.json({ version: TEST_BUILD_VERSION, pid: process.pid });
    if (badDefault && url === f.url + "/api/model/default") return Response.json({ location: { directory: f.root }, data: { providerID: "fixture", id: "model" } });
    if (malformedModel && url.startsWith(f.url + "/api/session/ses_") && init?.method !== "POST") {
      const body = await response.json() as any; body.data.model = { providerID: "fixture" }; return Response.json(body);
    }
    if (badSession && url.startsWith(f.url + "/api/session/ses_") && init?.method !== "POST") {
      const body = await response.json() as any; body.data.location.directory = f.root; return Response.json(body);
    }
    if (badCatalog && url === f.url + "/api/model") return Response.json({ location: { directory: f.project }, data: [] });
    return response;
  }) as typeof fetch;
  try {
    expect(acceptedOpencodeVersionsFor("v2")).toEqual(["2.0.22"]);
    const info = await f.api("/api/info"); expect(info.version).toBe(TEST_BUILD_VERSION); expect(info.pid).toBe(f.native.pid);
    const evidence = await observeSharedTestBuild(f.url, info.version); expect(evidence).toBeDefined();
    for (const change of [{ startTicks: evidence!.startTicks + 1 }, { listenInode: "0" }, { uid: evidence!.uid + 1 }, { executableIdentity: "changed" }]) {
      expect(await observeSharedTestBuild(f.url, info.version, { ...evidence!, ...change })).toBeUndefined();
    }
    expect(await acceptsSharedVersion(f.url, info, false)).toBe(false);
    expect(await acceptsSharedVersion(f.url, { ...info, pid: process.pid }, true)).toBe(false);
    expect(await acceptsSharedVersion(f.url, { ...info, version: TEST_BUILD_VERSION + ".fake" }, true)).toBe(false);
    const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(info) });
    try { expect(await acceptsSharedVersion(`http://127.0.0.1:${fake.port}`, { version: TEST_BUILD_VERSION, pid: process.pid }, true)).toBe(false); } finally { fake.stop(true); }
    const id = (await f.api("/api/session", { location: { directory: f.project } })).data.id;
    const p = f.profile(id, "runtime-child");
    const open = () => openVettedOpenCodeCopresence({ backend: OPENCODE_V2_BACKEND, binary, cwd: f.project, workDir: p.dir, model: "fixture/model",
      env: { ANET_VARIANT_TEST_ONLY: "1", ANET_SHARED_VARIANT_PROFILE: p.configPath }, expectedVersion: TEST_BUILD_VERSION,
      sharedServer: { url: f.url, password: f.password, passwordFile: p.passwordFile }, resumeSessionId: id, newSession: false,
      tmuxRunner: () => { throw Error("unexpected_tmux"); }, tmuxRespawn: () => { throw Error("unexpected_tmux"); } });
    const count = postedPaths.length;
    f.policy({ test_only_shared_variant: false }); await expect(open()).rejects.toThrow(/server version/); expect(postedPaths.length).toBe(count);
    f.policy(); const registry = readFileSync(f.registryPath, "utf8"); writeFileSync(f.registryPath, JSON.stringify({ url: "http://127.0.0.1:1", passwordFile: p.passwordFile }));
    await expect(open()).rejects.toThrow(/server version/); expect(postedPaths.length).toBe(count); writeFileSync(f.registryPath, registry);
    session = await open(); expect(session.variantConfigCapable).toBe(true);
    const catalog = await f.api("/api/model"), selected = await f.api(`/api/session/${id}`), started = performance.now();
    const def = await f.api("/api/model/default");
    let readback;
    const readyDeadline = Date.now() + 10000;
    do { readback = await session.variantConfigReadback(); if (readback) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < readyDeadline);
    console.log("SHARED_READBACK_DIAG", JSON.stringify({ elapsedMs: Math.round(performance.now() - started), model: selected.data.model,
      defaultDirectoryMatches: def.location?.directory === f.project,
      effective: await session.selectedSessionModel(id), catalogDirectoryMatches: catalog.location?.directory === f.project, freshCompleteCatalogAccepted: !!readback }));
    expect(readback).toEqual({ providerID: "fixture", id: "model", variant: "default" });
    expect((await f.api(`/api/session/${id}`)).data.model).toBeUndefined(); expect(postedPaths.length).toBe(count);
    badDefault = true; expect(await session.variantConfigReadback()).toBeUndefined(); badDefault = false;
    malformedModel = true; expect(await session.variantConfigReadback()).toBeUndefined(); malformedModel = false; expect(postedPaths.length).toBe(count);
    expect(await session.selectSessionModel(id, { providerID: "fixture", id: "model", variant: "high" })).toEqual({ status: "applied", model: { providerID: "fixture", id: "model", variant: "high" } });
    expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("high");
    await session.setSelectedModel("fixture/model"); expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("high");
    expect(await session.selectSessionModel(id, { providerID: "fixture", id: "model" })).toEqual({ status: "applied", model: { providerID: "fixture", id: "model", variant: "default" } });
    const noWrites = postedPaths.length;
    badInfo = true; expect(await session.variantConfigReadback()).toBeUndefined();
    expect((await session.selectSessionModel(id, { providerID: "fixture", id: "model", variant: "high" })).status).toBe("rejected"); badInfo = false;
    badSession = true; expect(await session.variantConfigReadback()).toBeUndefined();
    expect((await session.selectSessionModel(id, { providerID: "fixture", id: "model", variant: "high" })).status).not.toBe("applied"); badSession = false;
    expect(postedPaths.length).toBe(noWrites);
    badCatalog = true; expect(await session.variantConfigReadback()).toBeUndefined();
    expect((await session.selectSessionModel(id, { providerID: "fixture", id: "model", variant: "high" })).status).toBe("rejected"); badCatalog = false;
    f.policy({ test_only_shared_variant: false }); expect(await session.variantConfigReadback()).toBeUndefined();
    expect((await session.selectSessionModel(id, { providerID: "fixture", id: "model", variant: "high" })).status).toBe("rejected"); expect(postedPaths.length).toBe(noWrites); f.policy();
    const original = JSON.stringify(p.config); p.config.sourceDelivery.server_pid = process.pid;
    writeFileSync(p.configPath, JSON.stringify(p.config)); expect(await session.variantConfigReadback()).toBeUndefined();
    expect((await session.selectSessionModel(id, { providerID: "fixture", id: "model", variant: "high" })).status).toBe("rejected"); expect(postedPaths.length).toBe(noWrites); writeFileSync(p.configPath, original);
    await f.api(`/api/session/${id}/prompt`, { text: "synthetic held local completion" });
    await Promise.race([f.providerReached, new Promise<never>((_, reject) => setTimeout(() => reject(Error("provider_timeout")), 10000))]);
    expect(await session.selectSessionModel(id, { providerID: "fixture", id: "model", variant: "high" })).toEqual({ status: "rejected", reason: "busy" });
    expect((await f.api(`/api/session/${id}`)).data.model.variant).toBe("default"); expect((await f.api("/api/info")).pid).toBe(f.native.pid);
    console.log("SHARED_RUNTIME_ACCEPTANCE", JSON.stringify({ version: info.version, ownedNativeChild: false, high: true, clear: "default", busyPreserved: true, identityNegativesZeroWrite: true, providerCalls: f.providerCalls() }));
  } finally { await session?.close(); globalThis.fetch = fetchOriginal; await f.stop(); }
}, 90000);
