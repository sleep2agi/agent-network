import { describe, expect, test } from "bun:test";

import {
  ambientTypeScriptTranspiler,
  nodeServerPayloadFor,
  NodeServerPayloadError,
} from "./node-server-payload";

const TS_SOURCE = 'function loadEnvFile(path: string): void {}\nloadEnvFile("x");\n';

describe("nodeServerPayloadFor", () => {
  test("passes a .js source through byte-for-byte", () => {
    // A compiled bundle is already what the target expects. Re-processing it
    // would risk changing published bytes for no gain.
    const compiled = 'const a=1;console.log(a);\n';
    expect(nodeServerPayloadFor(compiled, "/pkg/dist/src/node-server.js", null)).toBe(compiled);
  });

  test("🔴 bundles a .ts source — types stripped AND relative imports inlined", async () => {
    // Both halves matter. Stripping types alone left `import "./channel-meta.js"`
    // pointing at a sibling that does not exist beside the destination, and the
    // node still died on "CommHub MCP readiness preflight failed (1)".
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "nsp-bundle-"));
    try {
      writeFileSync(join(root, "sibling.ts"), 'export const MARK: string = "from-sibling";\n');
      const entry = join(root, "entry.ts");
      writeFileSync(entry, 'import { MARK } from "./sibling";\nfunction f(x: string): void { console.log(MARK, x); }\nf("hi");\n');
      const out = nodeServerPayloadFor("unused", entry, ambientTypeScriptTranspiler());
      expect(out).not.toContain(": string");
      expect(out).toContain("from-sibling");        // 兄弟模块被内联了
      expect(out).not.toContain('from "./sibling"'); // 相对 import 没有留下
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("🔴 refuses a .ts source when it cannot bundle, instead of writing a doomed file", () => {
    // Writing it anyway is what issue #1216 was: the file landed, the node
    // started, and died three layers later on "CommHub MCP readiness preflight
    // failed (1)" — a message naming neither the file nor the reason.
    expect(() => nodeServerPayloadFor(TS_SOURCE, "/repo/src/node-server.ts", null))
      .toThrow(NodeServerPayloadError);
    expect(() => nodeServerPayloadFor(TS_SOURCE, "/repo/src/node-server.ts", null))
      .toThrow(/node-server\.ts/);
  });

  test("the refusal names what to do, not just what failed", () => {
    // An error that does not say "build the package" sends the reader back to
    // the same guessing this issue came from.
    let message = "";
    try { nodeServerPayloadFor(TS_SOURCE, "/repo/src/node-server.ts", null); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain("bun run build");
    expect(message).toContain("dist/src/node-server.js");
  });

  test("only the .ts extension triggers bundling, not the word appearing in the path", () => {
    // A directory called `.../typescript/` or a file `node-server.tsx.js`
    // must not be mistaken for a TypeScript source.
    const js = "const x=1;\n";
    expect(nodeServerPayloadFor(js, "/repo/typescript/node-server.js", null)).toBe(js);
    expect(nodeServerPayloadFor(js, "/repo/src/node-server.tsx.js", null)).toBe(js);
  });
});

describe("the bug this module exists to prevent", () => {
  test("🔴 control: bun refuses TypeScript under a .js name and accepts it under .ts", async () => {
    // This is the claim the old comment got wrong ("bun runs .ts content under
    // a .js extension fine"). Asserting it here means a future runtime change
    // that made the old approach viable would show up as a red test rather
    // than as folklore.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "node-server-payload-"));
    try {
      const asTs = join(root, "probe.ts");
      const asJs = join(root, "probe.js");
      writeFileSync(asTs, TS_SOURCE);
      writeFileSync(asJs, TS_SOURCE);

      const run = async (file: string) => {
        const proc = Bun.spawn(["bun", file], { stdout: "pipe", stderr: "pipe" });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        return { code, stderr };
      };

      const ts = await run(asTs);
      expect(ts.code, `.ts should run: ${ts.stderr}`).toBe(0);

      const js = await run(asJs);
      expect(js.code).not.toBe(0);
      expect(js.stderr).toMatch(/Expected .* but found|SyntaxError|Unexpected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("🔴 and the transpiled payload does run under a .js name", async () => {
    // The other half: proving the fix produces something the runtime accepts.
    // Without this, the test above only shows the old way was broken.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "node-server-payload-fixed-"));
    try {
      const target = join(root, "payload.js");
      const entry = join(root, "entry.ts");
      writeFileSync(entry, TS_SOURCE);
      writeFileSync(target, nodeServerPayloadFor("unused", entry, ambientTypeScriptTranspiler()));
      const proc = Bun.spawn(["bun", target], { stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code, stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("ambientTypeScriptTranspiler", () => {
  test("is available under bun, which is where the .ts fallback can be reached", () => {
    // The published CLI runs under node and gets null here — correct, because
    // it also never resolves a .ts candidate (its dist/ copy wins).
    expect(ambientTypeScriptTranspiler()).not.toBeNull();
  });
});
