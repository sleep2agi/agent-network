import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let server: ReturnType<typeof Bun.serve> | null = null;
let work = "";

afterEach(() => {
  try { server?.stop(true); } catch {}
  server = null;
  if (work) rmSync(work, { recursive: true, force: true });
  work = "";
});

describe("installed CLI-compatible node loop wire", () => {
  test("anet node loop emits the namespaced /aloop payload", async () => {
    const sourceRoot = process.env.TEST597_ROOT || process.cwd();
    let posted: any = null;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/api/task") {
          posted = await request.json();
          return Response.json({ ok: true, message_id: "task_597_wire" });
        }
        if (url.pathname === "/api/tasks") {
          return Response.json({
            ok: true,
            tasks: [{
              id: "task_597_wire",
              status: "replied",
              result: "[loop-target] 已创建 loop 目标 deadbeef（每 5 分钟）",
            }],
          });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    });

    work = mkdtempSync(join(tmpdir(), "anet-test597-cli-"));
    const nodeDir = join(work, ".anet", "nodes", "loop-target");
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, "config.json"), JSON.stringify({
      node_id: "n_test597_loop_target",
      node_name: "loop-target",
      alias: "loop-target",
      runtime: "codex-sdk",
      hub: `http://127.0.0.1:${server.port}`,
      network_id: "net_test597",
      token: "ntok_test597",
      channels: [],
      env: {},
      flags: {},
    }));

    const proc = Bun.spawn({
      cmd: [process.execPath, join(sourceRoot, "agent-network", "bin", "cli.ts"), "node", "loop", "loop-target", "update docs", "--every", "5m"],
      cwd: work,
      env: { ...process.env, HOME: work },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, rc] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (rc !== 0) throw new Error(`CLI exited ${rc}: ${stderr}\n${stdout}`);
    expect(stderr).toBe("");
    expect(posted?.task).toBe("/aloop 5m update docs");
    expect(stdout).toContain("sent as: /aloop 5m update docs");
  });
});
