// Docker only. Deliberately force model tool calls against pinned upstream V2.
// No production runtime gate is changed; all data and credentials are synthetic.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
const artifact = process.env.ARTIFACT_DIR!;
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
function check(name: string, ok: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) throw Error(name);
}
async function until(fn: () => Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await pause();
  }
  return false;
}
const results: any[] = [];
let current:
  | {
      tool: string;
      args: any;
      calls: number;
      observed: any[];
      offered: string[];
    }
  | undefined;
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 18828,
  async fetch(req) {
    if (req.method === "GET")
      return Response.json({ data: [{ id: "stub-model", object: "model" }] });
    const body: any = await req.json();
    const probe = current!;
    probe.offered = (body.tools ?? []).map((t: any) => t.function?.name);
    probe.observed.push(...body.messages.filter((m: any) => m.role === "tool"));
    const call = probe.calls++ === 0;
    const message = call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "probe828",
              type: "function",
              function: {
                name: probe.tool,
                arguments: JSON.stringify(probe.args),
              },
            },
          ],
        }
      : { role: "assistant", content: "PROBE828_DONE" };
    const base = {
      id: "completion828",
      object: "chat.completion",
      created: 1,
      model: "stub-model",
    };
    if (!body.stream)
      return Response.json({
        ...base,
        choices: [
          { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
        ],
      });
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [{ index: 0, ...message.tool_calls![0] }],
        }
      : message;
    const chunks = [
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: null }],
      },
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
        ],
      },
    ];
    return new Response(
      chunks.map((x) => "data: " + JSON.stringify(x) + "\n\n").join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
try {
  check(
    "L0 exact upstream V2",
    spawnSync("opencode", ["--version"], { encoding: "utf8" }).stdout.trim() ===
      "opencode v2.0.22",
  );
  for (const mode of [
    "allow",
    "native-deny",
    "project-deny",
    "project-allow-inline-deny",
    "inline-deny-then-allow",
    "v1-env-deny",
  ]) {
    const root = "/run/test828/" + mode,
      home = root + "/home",
      cwd = root + "/project";
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const deny = [
      "native-deny",
      "project-deny",
      "project-allow-inline-deny",
    ].includes(mode);
    if (mode === "project-allow-inline-deny")
      writeFileSync(
        cwd + "/opencode.json",
        JSON.stringify({
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }),
      );
    if (mode === "project-deny")
      writeFileSync(
        cwd + "/opencode.json",
        JSON.stringify({
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        }),
      );
    const config: any = {
      provider: {
        stub: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:18828/v1",
            apiKey: "test-only",
          },
          models: { "stub-model": { name: "Stub" } },
        },
      },
      model: "stub/stub-model",
      permissions: [
        { action: "*", resource: "*", effect: deny ? "deny" : "allow" },
      ],
    };
    if (mode === "project-deny") delete config.permissions;
    if (mode === "inline-deny-then-allow")
      config.permissions = [
        { action: "*", resource: "*", effect: "deny" },
        { action: "*", resource: "*", effect: "allow" },
      ];
    const child = spawn(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", "24828"],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          OPENCODE_PASSWORD: "test828",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          ...(mode === "v1-env-deny"
            ? { OPENCODE_PERMISSION: '{"*":"deny"}' }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    child.stdout!.on("data", (b) => (log += b));
    child.stderr!.on("data", (b) => (log += b));
    const headers = {
      authorization:
        "Basic " + Buffer.from("opencode:test828").toString("base64"),
      "content-type": "application/json",
    };
    const base = "http://127.0.0.1:24828";
    async function api(path: string, body?: any) {
      const r = await fetch(base + path, {
        headers,
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!r.ok) throw Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json() as Promise<any>;
    }
    try {
      check(
        `${mode}: L1 authenticated serve`,
        await until(() =>
          api("/api/info").then(
            () => true,
            () => false,
          ),
        ),
      );
      check(
        `${mode}: unauthenticated API rejected`,
        (await fetch(base + "/api/info")).status === 401,
      );
      for (const tool of ["shell", "read", "write", "edit"]) {
        const path = cwd + "/" + tool + ".txt";
        if (tool === "read") writeFileSync(path, "SECRET828_READ");
        if (tool === "edit") writeFileSync(path, "BEFORE828");
        const args =
          tool === "shell"
            ? { command: `printf SHELL828 > ${path}` }
            : tool === "write"
              ? { path, content: "WRITE828" }
              : tool === "edit"
                ? { path, oldString: "BEFORE828", newString: "AFTER828" }
                : { path };
        current = { tool, args, calls: 0, observed: [], offered: [] };
        const session = await api("/api/session", {
          title: `${mode}-${tool}`,
          model: { providerID: "stub", id: "stub-model" },
        });
        const id = session.data.id;
        await api(`/api/session/${id}/prompt`, {
          text: `Run the ${tool} probe now`,
          delivery: "queue",
        });
        let history: any;
        check(
          `${mode}/${tool}: L2 tool turn finishes`,
          await until(async () => {
            history = await api(
              `/api/session/${id}/message?order=desc&limit=100`,
            );
            return JSON.stringify(history).includes("PROBE828_DONE");
          }, 20000),
        );
        const output = JSON.stringify(current.observed);
        const content = existsSync(path) ? readFileSync(path, "utf8") : null;
        const executed =
          tool === "shell"
            ? content === "SHELL828"
            : tool === "write"
              ? content === "WRITE828"
              : tool === "edit"
                ? content === "AFTER828"
                : output.includes("SECRET828_READ");
        const unchanged =
          tool === "edit"
            ? content === "BEFORE828"
            : tool === "read"
              ? content === "SECRET828_READ" &&
                !output.includes("SECRET828_READ")
              : content === null;
        results.push({
          mode,
          tool,
          offered: current.offered,
          observed: current.observed,
          content,
          history,
        });
        console.log(
          JSON.stringify({
            mode,
            tool,
            offered: current.offered,
            output,
            content,
            executed,
          }),
        );
        check(
          `${mode}/${tool}: ${deny ? "execution denied" : "positive control executes"}`,
          deny ? !executed && unchanged : executed,
        );
        if (deny)
          check(
            `${mode}/${tool}: explicit refusal, not invalid arguments`,
            /denied|not allowed|not available|No tool named|not found|disabled|reject/i.test(
              output,
            ) && !/invalid.*argument|schema.*validation/i.test(output),
          );
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("exit", () => r()));
      writeFileSync(artifact + "/" + mode + ".log", log);
    }
  }
  console.log("PASS: test828 native tool policy probe");
} finally {
  model.stop();
  writeFileSync(artifact + "/results.json", JSON.stringify(results, null, 2));
}
