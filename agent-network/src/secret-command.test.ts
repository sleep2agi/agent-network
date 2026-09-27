import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeSecretCommand, secretCommand, trimPipedValue, type SecretContext } from "./secret-command";

// A value that must never appear in anything the command prints.
const SENTINEL = "sk-SENTINEL-7c1e0b-do-not-print";

let root: string;
let home: string;
let nodeDir: string;
let out: string[];
let piped: string;
let tty: boolean;

function ctx(configEnvKeys: string[] = []): SecretContext {
  return {
    home,
    resolveNode: (ref) => ref === "n1" ? { dir: nodeDir, id: "n1", configEnvKeys } : { error: `Node "${ref}" not found.` },
    io: {
      stdinIsTTY: tty,
      readValue: async () => piped,
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    },
  };
}
const all = () => out.join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "secret-cmd-"));
  home = join(root, "home");
  nodeDir = join(root, "proj", ".anet", "nodes", "n1");
  mkdirSync(home, { recursive: true });
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, "config.json"), "{}\n", { mode: 0o600 });
  out = [];
  piped = "";
  tty = false;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("anet secret set / node secret set", () => {
  test("piped value (trailing newline dropped) → daemon file 0600; node file next to config.json", async () => {
    piped = `${SENTINEL}\n`;
    expect(await secretCommand(["set", "OPENAI_API_KEY"], ctx())).toBe(0);
    const g = join(home, ".anet", "secrets.env");
    expect(readFileSync(g, "utf8")).toBe(`OPENAI_API_KEY=${SENTINEL}\n`);
    expect(statSync(g).mode & 0o777).toBe(0o600);

    piped = "node-value";
    expect(await nodeSecretCommand(["set", "n1", "OPENAI_API_KEY"], ctx())).toBe(0);
    expect(readFileSync(join(nodeDir, "secrets.env"), "utf8")).toBe("OPENAI_API_KEY=node-value\n");
    expect(all()).toContain("running nodes are not touched; it takes effect on their next start");
    expect(all()).not.toContain(SENTINEL);
  });

  test("a TTY value is kept verbatim (no newline trimming needed)", async () => {
    tty = true; piped = "abc ";
    expect(await secretCommand(["set", "K"], ctx())).toBe(0);
    expect(readFileSync(join(home, ".anet", "secrets.env"), "utf8")).toBe("K=\"abc \"\n");
  });

  test("a value on argv is refused and not echoed; nothing written", async () => {
    expect(await secretCommand(["set", "K", SENTINEL], ctx())).toBe(2);
    expect(await secretCommand(["set", `K=${SENTINEL}`], ctx())).toBe(2);
    expect(await nodeSecretCommand(["set", "n1", "K", SENTINEL], ctx())).toBe(2);
    expect(all()).toContain("never taken from the command line");
    expect(all()).not.toContain(SENTINEL);
    expect(() => statSync(join(home, ".anet", "secrets.env"))).toThrow();
  });

  test("invalid and reserved keys are refused", async () => {
    piped = "x";
    expect(await secretCommand(["set", "lower"], ctx())).toBe(1);
    expect(await secretCommand(["set", "PATH"], ctx())).toBe(1);
    expect(await nodeSecretCommand(["set", "n1", "COMMHUB_TOKEN"], ctx())).toBe(1);
    expect(await nodeSecretCommand(["set", "n1", "ANET_NODE_MARKER"], ctx())).toBe(1);
    expect(all()).toContain("reserved");
  });

  test("empty value writes nothing", async () => {
    piped = "\n";
    expect(await secretCommand(["set", "K"], ctx())).toBe(1);
  });

  test("unknown node → the resolver's message", async () => {
    expect(await nodeSecretCommand(["set", "nope", "K"], ctx())).toBe(1);
    expect(all()).toContain('Node "nope" not found.');
  });

  test("node set warns when config.json env also names the key (config wins)", async () => {
    piped = "v";
    expect(await nodeSecretCommand(["set", "n1", "API_KEY"], ctx(["API_KEY"]))).toBe(0);
    expect(all()).toContain("config.json env");
  });
});

describe("anet secret list never prints values", () => {
  test("sentinel in both files; output has keys, sources, lengths only", async () => {
    piped = SENTINEL;
    await secretCommand(["set", "SHARED"], ctx());
    await secretCommand(["set", "GLOBAL_ONLY"], ctx());
    piped = `${SENTINEL}-node`;
    await nodeSecretCommand(["set", "n1", "SHARED"], ctx());
    expect(await nodeSecretCommand(["set", "n1", "ONLY_ON_NODE"], ctx())).toBe(0);
    out = [];
    expect(await secretCommand(["list"], ctx())).toBe(0);
    expect(await secretCommand(["list", "--node", "n1"], ctx(["ONLY_ON_NODE"]))).toBe(0);
    expect(await nodeSecretCommand(["list", "n1"], ctx())).toBe(0);
    const text = all();
    // Positive control: the listing really did run over those keys.
    for (const k of ["SHARED", "GLOBAL_ONLY", "ONLY_ON_NODE", "overrides daemon", "ignored: config.json env", String(SENTINEL.length)]) {
      expect(text).toContain(k);
    }
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("SENTINEL");
  });

  test("an empty store says so", async () => {
    expect(await secretCommand(["list"], ctx())).toBe(0);
    expect(all()).toContain("(no secrets)");
  });
});

describe("unset", () => {
  test("removes the key; unsetting again is a no-op", async () => {
    piped = "v";
    await secretCommand(["set", "K"], ctx());
    await secretCommand(["set", "L"], ctx());
    expect(await secretCommand(["unset", "K"], ctx())).toBe(0);
    expect(readFileSync(join(home, ".anet", "secrets.env"), "utf8")).toBe("L=v\n");
    expect(await secretCommand(["unset", "K"], ctx())).toBe(0);
    expect(all()).toContain("running nodes keep it until their next start");
    expect(all()).toContain("was not set");
    expect(await nodeSecretCommand(["unset", "n1", "K"], ctx())).toBe(0);
  });
});

test("trimPipedValue drops exactly one trailing newline", () => {
  expect(trimPipedValue("a\n")).toBe("a");
  expect(trimPipedValue("a\r\n")).toBe("a");
  expect(trimPipedValue("a\n\n")).toBe("a\n");
  expect(trimPipedValue("a")).toBe("a");
});
