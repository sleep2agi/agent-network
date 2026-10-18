import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STANDALONE_BUILD_STAMP,
  STANDALONE_HUB_ARG,
  STANDALONE_NODE_ARG,
  STANDALONE_PRINT_CONFIG_TOKEN_ARG,
  applyStandaloneDetectedVersions,
  anetVersionFromStamp,
  cliReinvokeArgs,
  cliReinvokeShell,
  dispatchStandalone,
  formatAnetVersionBanner,
  isBundlerScriptSlot,
  isStandaloneBuild,
  nodeStyleArgv,
  standaloneBundleVersion,
  standaloneHubLaunch,
  standaloneNodeArgs,
  standaloneNodeServerJs,
  standaloneUserArgs,
  type StandaloneBuildStamp,
} from "./standalone-bin";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const stamp: StandaloneBuildStamp = {
  standalone: true,
  versions: {
    anet: "2.3.0-preview.164",
    agentNode: "2.5.0-preview.130",
    commhubServer: "0.9.0-preview.122",
    bundle: "2.3.0-preview.164",
  },
  nodeServerJs: "// anet-node-server-version: 2.3.0-preview.164\nconsole.log('ns');\n",
};

describe("standalone dispatch", () => {
  test("compiled and bun-script argv both yield the same user args", () => {
    expect(isBundlerScriptSlot("/$bunfs/root/anet-bin.js")).toBe(true);
    expect(isBundlerScriptSlot("/work/agent-network/bin/anet-bin.ts")).toBe(true);
    expect(isBundlerScriptSlot("--help")).toBe(false);
    expect(isBundlerScriptSlot("./notes.ts")).toBe(false);

    const fromBun = standaloneUserArgs(["bun", "/work/agent-network/bin/anet-bin.ts", "--help"]);
    const fromCompiled = standaloneUserArgs(["/usr/local/bin/anet", "--help"]);
    const fromBunfs = standaloneUserArgs([
      "/usr/local/bin/anet",
      "/$bunfs/root/anet-bin.js",
      STANDALONE_HUB_ARG,
      "--port",
      "9200",
    ]);
    expect(fromBun).toEqual(["--help"]);
    expect(fromCompiled).toEqual(["--help"]);
    expect(fromBunfs).toEqual([STANDALONE_HUB_ARG, "--port", "9200"]);
  });

  test("dispatches __hub and __node and leaves real CLI commands alone", () => {
    expect(dispatchStandalone(["--help"])).toEqual({ kind: "cli", argv: ["--help"] });
    expect(dispatchStandalone(["hub", "start"])).toEqual({ kind: "cli", argv: ["hub", "start"] });
    expect(dispatchStandalone([STANDALONE_HUB_ARG, "--port", "9200"])).toEqual({
      kind: "hub",
      argv: ["--port", "9200"],
    });
    expect(dispatchStandalone([STANDALONE_NODE_ARG, "--help"])).toEqual({
      kind: "node",
      argv: ["--help"],
    });
    expect(dispatchStandalone([STANDALONE_PRINT_CONFIG_TOKEN_ARG])).toEqual({
      kind: "print-config-token",
      argv: [],
    });
    expect(dispatchStandalone(["__nope"])).toEqual({ kind: "cli", argv: ["__nope"] });
  });

  test("node-style argv puts user args at slice(2)", () => {
    const argv = nodeStyleArgv("/usr/local/bin/anet", ["hub", "start"]);
    expect(argv.slice(2)).toEqual(["hub", "start"]);
  });
});

describe("standalone version injection", () => {
  test("committed stamp is inactive", () => {
    expect(STANDALONE_BUILD_STAMP).toEqual({
      standalone: false,
      versions: null,
      nodeServerJs: null,
    });
    expect(isStandaloneBuild(STANDALONE_BUILD_STAMP)).toBe(false);
    expect(anetVersionFromStamp(STANDALONE_BUILD_STAMP)).toBeNull();
    expect(standaloneBundleVersion(STANDALONE_BUILD_STAMP)).toBeNull();
    expect(standaloneNodeServerJs(STANDALONE_BUILD_STAMP)).toBeNull();
  });

  test("banner reports anet and the bundle version only when stamped", () => {
    expect(formatAnetVersionBanner("2.3.0-preview.164", null)).toBe("anet v2.3.0-preview.164\n\n");
    expect(formatAnetVersionBanner(stamp.versions!.anet, standaloneBundleVersion(stamp))).toBe(
      "anet v2.3.0-preview.164\nstandalone bundle v2.3.0-preview.164\n\n",
    );
  });

  test("detected packages prefer the embedded versions", () => {
    const detected = applyStandaloneDetectedVersions({
      anet: { version: "from-disk" },
      agentNode: { name: "agent-node", displayName: "agent-node", version: null, state: "not-installed" as const },
      commhubServer: { name: "commhub-server", displayName: "commhub-server", version: null, state: "not-installed" as const },
      bun: { name: "bunx", displayName: "Bun (bunx)", version: null, state: "not-installed" as const },
    }, stamp);
    expect(detected.anet.version).toBe("2.3.0-preview.164");
    expect(detected.agentNode).toMatchObject({ version: "2.5.0-preview.130", state: "ok", source: "standalone bundle" });
    expect(detected.commhubServer.version).toBe("0.9.0-preview.122");
    expect(detected.bun?.source).toBe("standalone bundle");
  });

  test("inactive stamp does not rewrite a disk detection", () => {
    const original = {
      anet: { version: "from-disk" },
      agentNode: { name: "agent-node", displayName: "agent-node", version: null, state: "not-installed" as const },
      commhubServer: { name: "commhub-server", displayName: "commhub-server", version: null, state: "not-installed" as const },
    };
    const out = applyStandaloneDetectedVersions(original, STANDALONE_BUILD_STAMP);
    expect(out.anet.version).toBe("from-disk");
    expect(out.agentNode.state).toBe("not-installed");
  });

  test("embedded node-server payload is used only for a real stamp", () => {
    expect(standaloneNodeServerJs(stamp)).toContain("anet-node-server-version");
    expect(standaloneNodeServerJs({ ...stamp, nodeServerJs: "" })).toBeNull();
    expect(standaloneNodeServerJs({ ...stamp, standalone: false })).toBeNull();
  });
});

describe("standalone self-spawn", () => {
  test("npm/node reinvoke keeps the script path and optional execArgv", () => {
    expect(cliReinvokeArgs({
      standalone: false,
      execArgv: ["--enable-source-maps"],
      scriptPath: "/pkg/dist/bin/cli.js",
      cliArgs: ["hub", "start", "--port", "9200"],
      includeExecArgv: false,
    })).toEqual(["/pkg/dist/bin/cli.js", "hub", "start", "--port", "9200"]);

    expect(cliReinvokeArgs({
      standalone: false,
      execArgv: ["--import", "tsx"],
      scriptPath: "/src/cli.ts",
      cliArgs: ["node", "start", "demo", "--copresence", "--tui-first"],
      includeExecArgv: true,
    })).toEqual(["--import", "tsx", "/src/cli.ts", "node", "start", "demo", "--copresence", "--tui-first"]);
  });

  test("compiled reinvoke drops the virtual script path and execArgv", () => {
    expect(cliReinvokeArgs({
      standalone: true,
      execArgv: ["--import", "tsx"],
      scriptPath: "/$bunfs/root/cli.js",
      cliArgs: ["hub", "start", "--port", "9200"],
      includeExecArgv: true,
    })).toEqual(["hub", "start", "--port", "9200"]);

    expect(cliReinvokeShell({
      standalone: true,
      execPath: "/usr/local/bin/anet",
      execArgv: [],
      scriptPath: "/$bunfs/root/cli.js",
      cliArgs: [],
      includeExecArgv: false,
      quote,
    })).toBe("'/usr/local/bin/anet'");
  });

  test("hub and node spawns use internal argv only when standalone", () => {
    const launched = standaloneHubLaunch(stamp, {
      explicitVersion: null,
      port: "9200",
      host: "127.0.0.1",
      devOpen: true,
    });
    expect(launched.ok).toBe(true);
    if (launched.ok) {
      expect(launched.args).toEqual([STANDALONE_HUB_ARG, "--port", "9200", "--host", "127.0.0.1", "--dev-open"]);
      expect(launched.version).toBe("0.9.0-preview.122");
      expect(launched.origin).toContain("standalone bundle v2.3.0-preview.164");
    }
    const refused = standaloneHubLaunch(stamp, {
      explicitVersion: "0.9.0-preview.1",
      port: "9200",
      host: "127.0.0.1",
      devOpen: false,
    });
    expect(refused.ok).toBe(false);
    expect(standaloneHubLaunch(STANDALONE_BUILD_STAMP, {
      explicitVersion: null,
      port: "9200",
      host: "127.0.0.1",
      devOpen: false,
    }).ok).toBe(false);

    expect(standaloneNodeArgs(["--alias", "demo"])).toEqual([STANDALONE_NODE_ARG, "--alias", "demo"]);
  });
});

describe("cli.ts wiring", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");

  test("self-spawns go through the standalone helpers and the bunx guard stays singular", () => {
    expect(cli).toContain("reinvokeArgv(");
    expect(cli).toContain("reinvokeShell(");
    expect(cli).toContain("standaloneHubLaunch(");
    expect(cli).toContain("standaloneNodeArgs(");
    expect(cli).toContain('spawnLauncher("bunx", serverArgs');
    expect(cli.match(/if \(!commandExists\("bunx"\)\) \{/g)?.length).toBe(1);
    expect(cli).not.toContain("spawn(process.execPath, [process.argv[1]");
  });
});
