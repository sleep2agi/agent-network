import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnedOpenCodeV2Catalog } from "./opencode-v2-catalog-daemon";
import { writeOpenCodeV2CatalogEndpoint, readOpenCodeV2CatalogEndpoint } from "./opencode-v2-catalog-endpoint";

const directory = "/tmp/oc-catalog-project";
const scope = { networkId: "net-fixture", daemonId: "daemon-a" };
const wrap = (data: unknown) => ({ location: { directory }, data });
const providers = [{ id: "custom", activation: "enabled", headers: { Authorization: "sk-FAKE-hidden" }, settings: { apiKey: "sk-FAKE-hidden" } }];
const models = [{ providerID: "custom", id: "nested/model", headers: { key: "sk-FAKE-hidden" } }];

test("owned endpoint returns an unverified snapshot and a missing endpoint does not connect", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    requests++;
    const url = new URL(req.url);
    if (req.headers.get("authorization") !== "Basic fake") return new Response("no", { status: 401 });
    const body = url.pathname === "/api/provider" ? providers : url.pathname === "/api/model" ? models : models[0];
    return Response.json(wrap(body));
  } });
  const dir = mkdtempSync(join(tmpdir(), "oc-owned-"));
  try {
    const url = `http://127.0.0.1:${server.port}`;
    writeOpenCodeV2CatalogEndpoint(dir, { url, authorization: "Basic fake", directory });
    const read = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: directory, ownedProjectDirectory: directory,
      endpoint: readOpenCodeV2CatalogEndpoint(dir),
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.snapshot.invocationVerified).toBe(false);
    expect(read.snapshot.completeness).toBe("unknown");
    expect(read.snapshot.models).toEqual([{ providerId: "custom", id: "nested/model" }]);
    expect(JSON.stringify(read.snapshot)).not.toContain("sk-FAKE");
    expect(requests).toBe(3);

    const missing = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: directory, ownedProjectDirectory: directory, endpoint: null,
    });
    expect(missing).toEqual({ ok: false, error: "unavailable" });
    expect(requests).toBe(3);

    const mismatch = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: "/tmp/other-project", ownedProjectDirectory: directory,
      endpoint: readOpenCodeV2CatalogEndpoint(dir),
    });
    expect(mismatch).toEqual({ ok: false, error: "scope_mismatch" });
    expect(requests).toBe(3);

    writeOpenCodeV2CatalogEndpoint(dir, { url, authorization: "Basic wrong", directory });
    const denied = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: directory, ownedProjectDirectory: directory,
      endpoint: readOpenCodeV2CatalogEndpoint(dir),
    });
    expect(denied).toEqual({ ok: false, error: "unauthorized" });
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tilde and symlink workdirs match the endpoint, and the snapshot keeps the authorized absolute path", async () => {
  const real = mkdtempSync(join(homedir(), ".oc-catalog-canon-"));
  const linkParent = mkdtempSync(join(tmpdir(), "oc-catalog-link-"));
  const link = join(linkParent, "link");
  symlinkSync(real, link);
  const tilde = `~/${real.slice(homedir().length + 1)}`;
  let queried = "";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const url = new URL(req.url);
    queried = url.searchParams.get("directory") || "";
    const row = url.pathname === "/api/model/default" ? { providerID: "custom", id: "m" } : url.pathname === "/api/model"
      ? [{ providerID: "custom", id: "m" }] : [{ id: "custom", activation: "enabled" }];
    return Response.json({ location: { directory: queried }, data: row });
  } });
  const dir = mkdtempSync(join(tmpdir(), "oc-owned-canon-"));
  try {
    const endpointDirectory = real;
    writeOpenCodeV2CatalogEndpoint(dir, { url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake", directory: endpointDirectory });
    const endpoint = readOpenCodeV2CatalogEndpoint(dir);
    const viaLink = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: link, ownedProjectDirectory: endpointDirectory, endpoint,
    });
    expect(viaLink.ok).toBe(true);
    if (!viaLink.ok) return;
    expect(queried).toBe(endpointDirectory);
    expect(viaLink.snapshot.scope.directory).toBe(link);

    const viaTilde = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: tilde, ownedProjectDirectory: endpointDirectory, endpoint,
    });
    expect(viaTilde.ok).toBe(true);
    if (!viaTilde.ok) return;
    expect(viaTilde.snapshot.scope.directory).toBe(endpointDirectory);

    const mismatch = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: "~/not-the-endpoint", ownedProjectDirectory: endpointDirectory, endpoint,
    });
    expect(mismatch).toEqual({ ok: false, error: "scope_mismatch" });

    const windows = await readOwnedOpenCodeV2Catalog({
      ...scope, authorizedDirectory: "C:/project", ownedProjectDirectory: "C:\\project",
      endpoint: { url: `http://127.0.0.1:${server.port}`, authorization: "Basic fake", directory: "C:\\project" },
    });
    expect(windows.ok).toBe(true);
    if (windows.ok) expect(windows.snapshot.scope.directory).toBe("C:/project");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});
