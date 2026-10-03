// #511 — `anet hub start` must launch the commhub-server of anet's channel,
// honor --version, say where the version came from, and never silently run an
// old cached Hub. npm and the filesystem are mocked: nothing is installed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareSemver,
  formatHubVersionBanner,
  listCachedServerVersions,
  resolveHubChannel,
  resolveHubServerVersion,
  type CacheFs,
  type ExecFn,
} from "./hub-server-version";

const FLOOR = "0.9.0-preview.47";
const ANET_TAGS = { latest: "2.3.0-preview.76", preview: "2.3.0-preview.124" };
const SERVER_TAGS = { latest: "0.9.0-preview.30", preview: "0.9.0-preview.95" };
const CACHE = "/fake/.bun/install/cache";

function mockExec(opts: { down?: boolean; anet?: object; server?: object } = {}) {
  const calls: string[] = [];
  const exec: ExecFn = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (opts.down) throw new Error("npm ERR! network ETIMEDOUT");
    if (cmd !== "npm" || args[0] !== "view" || args[2] !== "dist-tags") throw new Error(`unexpected exec ${cmd} ${args.join(" ")}`);
    if (args[1] === "@sleep2agi/agent-network") return JSON.stringify(opts.anet ?? ANET_TAGS);
    if (args[1] === "@sleep2agi/commhub-server") return JSON.stringify(opts.server ?? SERVER_TAGS);
    throw new Error(`unexpected package ${args[1]}`);
  };
  return { exec, calls };
}

// Fake bun install cache holding the given commhub-server versions, in both
// directory layouts bun uses (prerelease part hashed in the dir name).
function fakeCache(versions: string[]): CacheFs {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const scope = `${CACHE}/@sleep2agi`;
  dirs.set(scope, ["commhub-server", "agent-node@2.5.0-deadbeef@@@1"]);
  dirs.set(`${scope}/commhub-server`, []);
  files.set(`${scope}/agent-node@2.5.0-deadbeef@@@1/package.json`, JSON.stringify({ name: "@sleep2agi/agent-node", version: "9.9.9" }));
  versions.forEach((v, i) => {
    const hashed = `${v.split("-")[0]}-${(i + 1).toString(16).padStart(16, "0")}@@@1`;
    if (i % 2 === 0) {
      dirs.get(scope)!.push(`commhub-server@${hashed}`);
      files.set(`${scope}/commhub-server@${hashed}/package.json`, JSON.stringify({ name: "@sleep2agi/commhub-server", version: v }));
    } else {
      dirs.get(`${scope}/commhub-server`)!.push(hashed);
      files.set(`${scope}/commhub-server/${hashed}/package.json`, JSON.stringify({ name: "@sleep2agi/commhub-server", version: v }));
    }
  });
  return {
    existsSync: (p) => dirs.has(p) || files.has(p),
    readdirSync: (p) => { const d = dirs.get(p); if (!d) throw new Error(`ENOENT ${p}`); return d; },
    readFileSync: (p) => { const f = files.get(p); if (f === undefined) throw new Error(`ENOENT ${p}`); return f; },
  };
}

function resolve(o: { anetVersion?: string; explicit?: string; channelFlag?: string; down?: boolean; cache?: string[]; server?: object }) {
  const m = mockExec({ down: o.down, server: o.server });
  const d = resolveHubServerVersion({
    explicit: o.explicit ?? null,
    channelFlag: o.channelFlag ?? null,
    anetVersion: o.anetVersion ?? ANET_TAGS.preview,
    floor: FLOOR,
    exec: m.exec,
    cacheDir: CACHE,
    fs: fakeCache(o.cache ?? []),
  });
  return { d, calls: m.calls };
}

describe("#511 anet hub start — commhub-server version", () => {
  test("registry current, cache stale: launches the registry version, not the cached one", () => {
    const { d } = resolve({ cache: ["0.9.0-preview.47", "0.9.0-preview.30"] });
    expect(d.version).toBe("0.9.0-preview.95");
    expect(d.source).toBe("registry");
    expect(d.channel).toBe("preview");
    expect(d.cached).toBe(false);
    expect(d.warnings).toEqual([]);
    expect(formatHubVersionBanner(d)).toContain("@sleep2agi/commhub-server@0.9.0-preview.95");
    expect(formatHubVersionBanner(d)).toContain("source: registry");
  });

  test("registry current and already cached: same version, banner says it is cached", () => {
    const { d } = resolve({ cache: ["0.9.0-preview.95", "0.9.0-preview.47"] });
    expect(d.version).toBe("0.9.0-preview.95");
    expect(d.source).toBe("registry");
    expect(d.cached).toBe(true);
    expect(formatHubVersionBanner(d)).toContain("already in local bun cache");
  });

  test("the old hardcoded pin is no longer what a preview anet launches", () => {
    const { d } = resolve({});
    expect(d.version).not.toBe(FLOOR);
  });

  test("explicit --version wins and does not query the registry", () => {
    const { d, calls } = resolve({ explicit: "0.9.0-preview.60", cache: [] });
    expect(d.version).toBe("0.9.0-preview.60");
    expect(d.source).toBe("explicit");
    expect(calls).toEqual([]);
    expect(formatHubVersionBanner(d)).toContain("source: explicit");
  });

  test("explicit --version older than the floor runs, but warns", () => {
    const { d } = resolve({ explicit: "0.9.0-preview.30" });
    expect(d.version).toBe("0.9.0-preview.30");
    expect(d.warnings.join("\n")).toContain(FLOOR);
  });

  test("--version latest|preview selects the channel", () => {
    expect(resolve({ explicit: "preview", anetVersion: ANET_TAGS.latest }).d.version).toBe("0.9.0-preview.95");
    const latest = resolve({ explicit: "latest" }).d;
    expect(latest.channel).toBe("latest");
  });

  test("registry down + only a stale cache: never runs the stale cache, warns with both versions", () => {
    const { d } = resolve({ down: true, cache: ["0.9.0-preview.30", "0.9.0-preview.29"] });
    expect(d.version).toBe(FLOOR);
    expect(d.version).not.toBe("0.9.0-preview.30");
    expect(d.source).toBe("pinned-floor");
    const w = d.warnings.join("\n");
    expect(w).toContain("0.9.0-preview.30");
    expect(w).toContain(FLOOR);
    expect(w).toContain("--version 0.9.0-preview.30");
  });

  test("registry down + cache at/above the floor: uses newest cache, labelled cache, warns", () => {
    const { d } = resolve({ down: true, cache: ["0.9.0-preview.47", "0.9.0-preview.60", "0.9.0-preview.58"] });
    expect(d.version).toBe("0.9.0-preview.60");
    expect(d.source).toBe("cache");
    expect(d.cached).toBe(true);
    expect(d.warnings.length).toBe(1);
    expect(formatHubVersionBanner(d)).toContain("source: cache");
  });

  test("registry down + empty cache: floor, with a warning", () => {
    const { d } = resolve({ down: true });
    expect(d.version).toBe(FLOOR);
    expect(d.warnings.join("\n")).toContain("registry");
  });

  test("latest-channel anet: server latest tag older than the floor is lifted to the floor", () => {
    const { d } = resolve({ anetVersion: ANET_TAGS.latest });
    expect(d.channel).toBe("latest");
    expect(d.version).toBe(FLOOR);
    expect(d.source).toBe("pinned-floor");
    expect(d.origin).toContain("0.9.0-preview.30");
  });

  test("latest-channel anet: server latest tag newer than the floor is used", () => {
    const { d } = resolve({ anetVersion: ANET_TAGS.latest, server: { latest: "0.9.0-preview.90", preview: "0.9.0-preview.95" } });
    expect(d.version).toBe("0.9.0-preview.90");
    expect(d.source).toBe("registry");
  });

  test("--channel override beats detection", () => {
    expect(resolve({ anetVersion: ANET_TAGS.latest, channelFlag: "preview" }).d.version).toBe("0.9.0-preview.95");
  });
});

describe("#511 channel + semver helpers", () => {
  test("a -preview suffix alone does not mean the preview channel", () => {
    expect(resolveHubChannel({ anetVersion: "2.3.0-preview.76", anetDistTags: ANET_TAGS }).channel).toBe("latest");
    expect(resolveHubChannel({ anetVersion: "2.3.0-preview.124", anetDistTags: ANET_TAGS }).channel).toBe("preview");
    expect(resolveHubChannel({ anetVersion: "2.3.0-preview.100", anetDistTags: ANET_TAGS }).channel).toBe("preview");
    expect(resolveHubChannel({ anetVersion: "2.3.0-preview.50", anetDistTags: ANET_TAGS }).channel).toBe("latest");
    expect(resolveHubChannel({ anetVersion: "2.4.0", anetDistTags: null }).channel).toBe("latest");
    expect(resolveHubChannel({ anetVersion: "2.3.0-preview.9", anetDistTags: null }).channel).toBe("preview");
  });

  test("compareSemver orders prerelease numerically", () => {
    expect(compareSemver("0.9.0-preview.95", "0.9.0-preview.47")).toBe(1);
    expect(compareSemver("0.9.0-preview.9", "0.9.0-preview.10")).toBe(-1);
    expect(compareSemver("0.9.0", "0.9.0-preview.95")).toBe(1);
    expect(compareSemver("0.9.0-preview.47", "0.9.0-preview.47")).toBe(0);
  });

  test("cache listing reads package.json in both bun layouts and ignores other packages", () => {
    expect(listCachedServerVersions(CACHE, fakeCache(["0.9.0-preview.1", "0.9.0-preview.2", "0.9.0-preview.3"])).sort())
      .toEqual(["0.9.0-preview.1", "0.9.0-preview.2", "0.9.0-preview.3"]);
    expect(listCachedServerVersions("/nonexistent", fakeCache(["0.9.0-preview.1"]))).toEqual([]);
  });
});

describe("#511 cli.ts wiring", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
  test("bunx gets the resolved version, not the pinned constant", () => {
    expect(cli).toContain("`@sleep2agi/commhub-server@${hubVersion.version}`");
    expect(cli).not.toContain("`@sleep2agi/commhub-server@${PINNED_SERVER_VERSION}`");
  });
  test("start prints the banner and every warning", () => {
    expect(cli).toContain("formatHubVersionBanner(hubVersion)");
    expect(cli).toContain("for (const w of hubVersion.warnings)");
    expect(cli).toContain("floor: PINNED_SERVER_VERSION");
  });
});
