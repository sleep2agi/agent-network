import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const runtime = process.env.PIN_RUNTIME_VERSION ?? "2.5.0-preview.210";
assert(["2.5.0-preview.210", "2.5.0-preview.209"].includes(runtime));
const expectedIntegrity: Record<string, string> = {
  "agent-network": "sha512-E/LjgJdA/EB+YGezdlVsRXssQ0Nr2o5X3UHnFyS2jKGb3iiy1B7vg3ZBcZbyPuT0nwBqlkBYBWjiNCENHh2/UQ==",
  "agent-node": "sha512-GsvWdcrFGSh0D3Wt43S5Sf3HQX2l0RuruEgEp37yeMaNFEzjD7ifV1z1K60p9vez9tsDdSKax45lE78pECrwDA==",
};
for (const [name, version] of [["agent-network", "2.3.0-preview.242"], ["agent-node", runtime]]) {
  const response = await fetch(`https://registry.npmjs.org/@sleep2agi%2f${name}/${version}`, { signal: AbortSignal.timeout(60_000) });
  assert(response.ok, `NOT_RUN: npm ${name}@${version} unavailable: ${response.status}`);
  const metadata = await response.json() as any;
  assert.equal(metadata.version, version);
  const url = `https://registry.npmjs.org/@sleep2agi/${name}/-/${name}-${version}.tgz`;
  assert.equal(metadata.dist.tarball, url);
  const archive = await fetch(url, { signal: AbortSignal.timeout(60_000) }); assert(archive.ok);
  const bytes = Buffer.from(await archive.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, metadata.dist.integrity);
  if (version === "2.5.0-preview.209") assert.equal(sha256, "cc32d818e9f780a60a1d6c976d5a9ea2174b0a9cf4e5700f626f9a377ad489b1");
  else assert.equal(integrity, expectedIntegrity[name]);
  const dir = `/tmp/published-${name}`; mkdirSync(dir, { recursive: true });
  await Bun.write(`${dir}/package.tgz`, bytes);
  execFileSync("tar", ["-xzf", `${dir}/package.tgz`, "-C", dir], { timeout: 10_000 });
  const manifest = JSON.parse(readFileSync(`${dir}/package/package.json`, "utf8"));
  const locked = JSON.parse(readFileSync(`${name}/package.json`, "utf8"));
  assert.equal(manifest.name, `@sleep2agi/${name}`); assert.equal(manifest.version, version);
  assert.deepEqual(manifest.dependencies, locked.dependencies, "published dependency declarations must match the checked-in locked inputs");
  cpSync(`${dir}/package/dist`, `${name}/dist`, { recursive: true });
  cpSync(`${dir}/package/package.json`, `${name}/package.json`);
  let buildInfo: unknown;
  if (existsSync(`${dir}/package/build-info.json`)) {
    cpSync(`${dir}/package/build-info.json`, `${name}/build-info.json`);
    buildInfo = JSON.parse(readFileSync(`${dir}/package/build-info.json`, "utf8"));
  }
  const entry = name === "agent-node" ? "dist/cli.js" : "dist/bin/anet.cjs";
  console.log(JSON.stringify({ published_package: manifest.name, version, tarball: url, sha256, integrity,
    entry_sha256: createHash("sha256").update(readFileSync(`${name}/${entry}`)).digest("hex"), build_info: buildInfo }));
}
