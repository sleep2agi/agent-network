import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnetArgsDaemon, handleCreateNodeDoorbell } from "./create-node-daemon";

test("source_ref cannot be silently treated as ordinary daemon creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "source4150-guard-"));
  const spec = { name: "source-guard", runtime: "opencode-cli", model: "fixture/model",
    flags: { opencodeGeneration: "v2", opencodeUnsafeTools: true } };
  try {
    for (const value of ["src_fixture", null, "", {}, undefined]) {
      for (const location of ["request", "spec", "flags"]) {
        const calls: { tool: string; args: Record<string, unknown> }[] = [];
        let spawned = false, serialized = false;
        const request: any = { ok: true, child_token: "fixture-not-a-real-token", network_id: "net_fixture",
          node_spec: { ...spec, flags: { ...spec.flags }, workdir: join(root, "must-not-create") } };
        if (location === "request") request.source_ref = value;
        else if (location === "spec") request.node_spec.source_ref = value;
        else request.node_spec.flags.source_ref = value;
        await handleCreateNodeDoorbell({ request_id: "cr_source_guard" }, {
          workDir: root, hubUrl: "http://fixture.invalid", log() {}, warn() {},
          serializeEnvLocal: () => { serialized = true; return ""; },
          spawnChild: () => { spawned = true; throw Error("unexpected spawn"); },
          callCommHub: async (tool, args) => {
            calls.push({ tool, args });
            return tool === "get_create_request" ? request : { ok: true };
          },
        });
        expect(calls).toEqual([
          { tool: "get_create_request", args: { request_id: "cr_source_guard" } },
          { tool: "ack_create_request", args: { request_id: "cr_source_guard", status: "rejected", error: "session_source_unsupported" } },
        ]);
        expect(spawned).toBe(false);
        expect(serialized).toBe(false);
        expect(existsSync(join(root, "must-not-create"))).toBe(false);
        expect(readdirSync(root)).toEqual([]);
      }
    }
    expect(buildAnetArgsDaemon(spec)).toContain("source-guard");
    expect(() => buildAnetArgsDaemon({ ...spec, source_ref: "src_fixture" } as any)).toThrow("session_source_unsupported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
