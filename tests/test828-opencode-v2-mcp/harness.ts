// Docker-only: real pinned V2, real isolated Hub, deterministic model tool calls.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { wireOpenCodeV2CommhubMcp, waitForOpenCodeV2Commhub } from "/opt/node_modules/@sleep2agi/agent-node/src/runtime/opencode-copresence/v2-session.ts";

const artifact = process.env.ARTIFACT_DIR ?? "/artifacts";
const root =
  "/run/test828-mcp/" +
  (process.env.TEST828_SWAP_TOKEN === "1" ? "wrong-token" : "positive");
for (const dir of [artifact, root])
  mkdirSync(dir, { recursive: true, mode: 0o700 });
const hub = "http://127.0.0.1:9288";
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) =>
  s.replace(/\b(?:atok|ntok|utok)_[A-Za-z0-9_-]+/g, "[test-token]");
function check(name: string, ok: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
  if (!ok) throw Error(name);
}
async function until(fn: () => Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await pause();
  }
  return false;
}
function childProcess(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (e) => {
      log += e.message;
      resolve();
    });
  });
  child.stdout!.on("data", (b) => (log += b));
  child.stderr!.on("data", (b) => (log += b));
  return {
    async stop(file: string) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(killTimer);
      writeFileSync(`${artifact}/${file}`, redact(log));
    },
  };
}
async function rest(path: string, token = "", body?: any) {
  const r = await fetch(hub + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw Error(`${path}: HTTP ${r.status} ${redact(await r.text())}`);
  return r.json() as Promise<any>;
}
async function rpc(token: string, name: string, args: any) {
  const r = await fetch(hub + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await r.text();
  if (!r.ok) throw Error(`MCP HTTP ${r.status}`);
  const lines = raw.split("\n").filter((s) => s.startsWith("data:"));
  const result = JSON.parse(lines.length ? lines.at(-1)!.slice(5).trim() : raw);
  return JSON.parse(result.result.content[0].text);
}
const evidence: any[] = [];
const mcpTraffic: any[] = [];
let boundToken = "";
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 9289,
  async fetch(req) {
    const body = req.method === "POST" ? await req.text() : undefined;
    const parsed = body ? JSON.parse(body) : {};
    if (parsed.method === "initialize" && process.env.TEST832_DELAY_MS) {
      await pause(Number(process.env.TEST832_DELAY_MS));
    }
    if (process.env.TEST832_REJECT_AUTH === "1") return new Response("Unauthorized", { status: 401 });
    const response = await fetch(hub + "/mcp", {
      method: req.method,
      headers: req.headers,
      body,
    });
    if (req.method !== "POST") return response;
    const raw = await response.text();
    mcpTraffic.push({
      method: parsed.method,
      name: parsed.params?.name,
      authOK: req.headers.get("authorization") === `Bearer ${boundToken}`,
      status: response.status,
      response: raw,
    });
    return new Response(raw, {
      status: response.status,
      headers: response.headers,
    });
  },
});
let current: {
  name: string;
  args: any;
  calls: number;
  offered: any[];
  observed: any[];
};
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 18829,
  async fetch(req) {
    if (req.method === "GET")
      return Response.json({ data: [{ id: "stub-model", object: "model" }] });
    const body: any = await req.json();
    current.offered = body.tools ?? [];
    current.observed.push(
      ...body.messages.filter((m: any) => m.role === "tool"),
    );
    const call = current.calls++ === 0;
    const message = call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "mcp828",
              type: "function",
              function: {
                name: current.name,
                arguments: JSON.stringify(current.args),
              },
            },
          ],
        }
      : { role: "assistant", content: "MCP828_DONE" };
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
    return new Response(
      [
        {
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          ...base,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
        },
      ]
        .map((x) => "data: " + JSON.stringify(x) + "\n\n")
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const server = childProcess("bun", ["src/index.ts"], "/workspace/server", {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: "9288",
  COMMHUB_DB: root + "/hub.db",
  COMMHUB_AUTH_TOKEN: "test828-bootstrap",
});
let opencode: ReturnType<typeof childProcess> | undefined;
try {
  console.log("L0 environment");
  check(
    "exact upstream V2",
    spawnSync("opencode", ["--version"], { encoding: "utf8" }).stdout.trim() ===
      "opencode v2.0.22",
  );
  check(
    "Hub ready",
    await until(() =>
      fetch(hub + "/health").then(
        (r) => r.ok,
        () => false,
      ),
    ),
  );
  check(
    "Hub unauthenticated write rejected",
    (
      await fetch(hub + "/api/task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: "receiver828", task: "unauth" }),
      })
    ).status === 401,
  );
  console.log("L1 isolated owner and node identities");
  await rest("/api/auth/register", "", {
    username: "mcp828",
    password: "Test828Password!",
  });
  const owner = await rest("/api/auth/login", "", {
    username: "mcp828",
    password: "Test828Password!",
  });
  const createdNet = await rest("/api/networks", owner.token, {
    name: "mcp828-private",
  });
  const networkId = createdNet.network?.network_id ?? createdNet.network_id;
  check("fresh network", typeof networkId === "string" && networkId.length > 0);
  const nodes: Record<string, any> = {};
  for (const alias of ["sender828", "receiver828", "decoy828"]) {
    nodes[alias] = await rest("/api/auth/node-token", owner.token, {
      network_id: networkId,
      node_name: alias,
      node_id: `n_${alias}`,
    });
    check(
      `${alias} node token`,
      String(nodes[alias].token).startsWith("ntok_"),
    );
    const status = await rpc(nodes[alias].token, "report_status", {
      alias,
      node_id: `n_${alias}`,
      resume_id: `sdk-${alias}`,
      status: "idle",
      network_id: networkId,
    });
    check(`${alias} registered`, status.ok);
  }
  const home = root + "/home",
    cwd = root + "/project";
  for (const d of [home, cwd]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    PWD: cwd,
    OPENCODE_PASSWORD: "test828",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "stub/stub-model",
      ...(process.env.TEST832_REGISTRY === "1" ? {
        plugins: [{ package: "/test828-mcp/registry-probe", options: { missing: process.env.TEST832_MISSING_TOOL === "1" } }],
      } : {}),
      provider: {
        stub: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:18829/v1",
            apiKey: "test-only",
          },
          models: { "stub-model": { name: "Stub" } },
        },
      },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    }),
  };
  boundToken = nodes.sender828.token;
  wireOpenCodeV2CommhubMcp(env, {
    url: "http://127.0.0.1:9289/mcp",
    token:
      process.env.TEST828_SWAP_TOKEN === "1"
        ? nodes.decoy828.token
        : boundToken,
    alias: "sender828",
  });
  check(
    "config uses env reference, not literal node token",
    !env.OPENCODE_CONFIG_CONTENT!.includes(nodes.sender828.token),
  );
  opencode = childProcess(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "24829"],
    cwd,
    env,
  );
  const base = "http://127.0.0.1:24829";
  async function api(path: string, body?: any) {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization:
          "Basic " + Buffer.from("opencode:test828").toString("base64"),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw Error(`V2 ${path}: ${r.status}`);
    return r.json() as Promise<any>;
  }
  check(
    "authenticated V2 ready",
    await until(() =>
      api("/api/info").then(
        () => true,
        () => false,
      ),
    ),
  );
  check(
    "V2 rejects unauthenticated access",
    (await fetch(base + "/api/info")).status === 401,
  );
  if (process.env.TEST832_READINESS === "1") {
    const started = Date.now();
    try {
      await waitForOpenCodeV2Commhub(base, "test828", Number(process.env.TEST832_TIMEOUT_MS ?? 10000));
      if (process.env.TEST832_REGISTRY === "1") {
        const deadline = started + Number(process.env.TEST832_TIMEOUT_MS ?? 10000);
        let ready = false, polls = 0;
        while (Date.now() < deadline) {
          const response = await fetch(base + "/api/rpc/anet.registry-probe/ready", {
            method: "POST",
            headers: { authorization: "Basic " + Buffer.from("opencode:test828").toString("base64"), "content-type": "application/json" },
            body: JSON.stringify({ input: {} }),
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
          if (!response.ok) throw Error(`Registry observation HTTP ${response.status}`);
          const result: any = await response.json();
          polls++;
          if (result.output?.ready === true) { ready = true; break; }
          if (result.output?.ready !== false) throw Error("Registry observation invalid schema");
          await pause(Math.min(25, Math.max(0, deadline - Date.now())));
        }
        if (!ready) throw Error("OpenCode v2 CommHub MCP readiness timed out waiting for final registry");
        console.log(`REGISTRY_READY polls=${polls} elapsedMs=${Date.now() - started}`);
      }
      check("MCP readiness gate completed", process.env.TEST832_EXPECT_FAILURE !== "1");
      if (process.env.TEST832_DELAY_MS) check("gate waited for delayed handshake", Date.now() - started >= Number(process.env.TEST832_DELAY_MS));
    } catch (error: any) {
      if (process.env.TEST832_EXPECT_FAILURE !== "1") throw error;
      console.log("READINESS_ERROR " + error.message);
      check("expected actionable MCP failure", /CommHub MCP (not ready \(failed\)|readiness timed out)/.test(error.message));
      check("failure did not call the model", evidence.length === 0 && current === undefined);
      console.log("PASS: readiness failure before model turn");
      process.exitCode = 0;
      // Let finally stop both private processes and capture evidence.
      throw Object.assign(new Error("TEST832_EXPECTED_FAILURE"), { expectedReadinessFailure: true });
    }
  }
  async function probe(label: string, args: any, tool = "send_task") {
    current = {
      name: "execute",
      args: {
        code: label.startsWith("discovery")
          ? `return search({query:"send_task",limit:5});`
          : `return await tools.commhub.${tool}(${JSON.stringify(args)});`,
      },
      calls: 0,
      offered: [],
      observed: [],
    };
    const session = await api("/api/session", {
      title: label,
      model: { providerID: "stub", id: "stub-model" },
    });
    await api(`/api/session/${session.data.id}/prompt`, {
      text: "Run the isolated MCP probe",
      delivery: "queue",
    });
    check(
      `${label} turn finishes`,
      await until(
        async () =>
          JSON.stringify(
            await api(
              `/api/session/${session.data.id}/message?order=desc&limit=100`,
            ),
          ).includes("MCP828_DONE"),
        30000,
      ),
    );
    evidence.push({ label, ...current });
    const result = JSON.parse(current.observed.at(-1)?.content ?? "null");
    console.log(
      redact(
        JSON.stringify({
          label,
          offered: current.offered.map((t: any) => t.function?.name),
          result: result?.items
            ? { paths: result.items.map((i: any) => i.path) }
            : result,
        }),
      ),
    );
    return result;
  }
  console.log(
    "L2 real model tool -> V2 Code Mode -> Hub -> authoritative task row",
  );
  // V2 may expose an empty Code Mode inventory on its first turn while MCP
  // connects. Record that limitation and require real discovery before dispatch.
  let discovered = false;
  for (let attempt = 0; attempt < (process.env.TEST832_READINESS === "1" ? 0 : 3); attempt++) {
    const found = await probe(`discovery-${attempt}`, {});
    if (found?.items?.some((i: any) => i.path === "tools.commhub.send_task")) {
      discovered = true;
      break;
    }
    await pause(300);
  }
  if (process.env.TEST832_READINESS !== "1") check("actual Code Mode catalog includes send_task", discovered);
  const marker = "MCP828_POSITIVE";
  const output = await probe("positive", {
    alias: "receiver828",
    task: marker,
    network_id: networkId,
  });
  check(
    "MCP tool result returns concrete message id",
    output?.ok === true && typeof output.message_id === "string",
  );
  const rows = (await rest(`/api/tasks?network_id=${networkId}`, owner.token))
    .tasks;
  const row = rows.find((r: any) => r.content === marker || r.task === marker);
  console.log("TASK_ROW " + redact(JSON.stringify(row)));
  check(
    "Hub actually persists exact dispatched task",
    row?.task_id === output.message_id && row.network_id === networkId,
  );
  check(
    "sender alias is token-bound",
    (row.from_name ?? row.from_session) === "sender828",
  );
  check(
    "sender and recipient stable node ids are preserved",
    row.from_node_id === "n_sender828" && row.to_node_id === "n_receiver828",
  );
  console.log(
    "L3 receiver terminal reply -> model get_task -> authoritative receipt",
  );
  const replied = await rpc(nodes.receiver828.token, "send_reply", {
    in_reply_to: row.task_id,
    text: "MCP828_RECEIPT",
    status: "replied",
    network_id: networkId,
  });
  check("recipient reply accepted", replied.ok === true);
  const receipt = await probe(
    "receipt",
    { task_id: row.task_id, network_id: networkId },
    "get_task",
  );
  const final = receipt.task ?? receipt;
  console.log("RECEIPT " + JSON.stringify(receipt));
  check(
    "model receives exact task terminal receipt",
    final.task_id === row.task_id &&
      final.status === "replied" &&
      final.result === "MCP828_RECEIPT",
  );
  console.log("L4 explicit sender spoof is refused without a task write");
  const bad = await probe("spoof", {
    alias: "receiver828",
    task: "MCP828_SPOOF",
    network_id: networkId,
    from_session: "decoy828",
  });
  check(
    "Hub explicitly refuses sender mismatch",
    bad?.ok === false && bad.error === "from_session_identity_mismatch",
  );
  const after = (await rest(`/api/tasks?network_id=${networkId}`, owner.token))
    .tasks;
  check(
    "spoof task not persisted",
    !after.some((r: any) => (r.content ?? r.task) === "MCP828_SPOOF"),
  );
  check(
    "real MCP calls use only the intended node credential",
    mcpTraffic.length > 0 && mcpTraffic.every((r) => r.authOK),
  );
  check(
    "real Hub saw both task dispatch and receipt tool calls",
    mcpTraffic.some(
      (r) => r.method === "tools/call" && r.name === "send_task",
    ) &&
      mcpTraffic.some(
        (r) => r.method === "tools/call" && r.name === "get_task",
      ),
  );
  console.log("PASS: real V2 MCP task and node identity");
} catch (error: any) {
  if (!error.expectedReadinessFailure) throw error;
} finally {
  await opencode?.stop("opencode.log");
  await server.stop("hub.log");
  model.stop(true);
  proxy.stop(true);
  writeFileSync(
    artifact + "/results.json",
    redact(JSON.stringify(evidence, null, 2)),
  );
  writeFileSync(
    artifact + "/mcp.json",
    redact(JSON.stringify(mcpTraffic, null, 2)),
  );
}
