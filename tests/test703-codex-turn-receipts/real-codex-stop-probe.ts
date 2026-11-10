import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.CODEX_BIN;
if (!binary) throw new Error("CODEX_BIN is required");

const home = mkdtempSync(join(tmpdir(), "test703-real-codex-"));
mkdirSync(home, { recursive: true });
const hanging = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
writeFileSync(join(home, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
[model_providers.fixture]
name = "fixture"
base_url = "http://127.0.0.1:${hanging.port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);

class Rpc {
  child: ChildProcessWithoutNullStreams;
  next = 1;
  pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  buffer = "";
  constructor() {
    this.child = spawn(binary!, ["app-server"], {
      env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id !== "number") continue;
        const pending = this.pending.get(msg.id); if (!pending) continue;
        this.pending.delete(msg.id);
        msg.error ? pending.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : pending.resolve(msg.result);
      }
    });
    this.child.stderr.on("data", () => {});
  }
  request(method: string, params?: any, timeout = 30_000): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  }
  notify(method: string, params: any) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  async init() {
    await this.request("initialize", { clientInfo: { name: "test703", title: "test703", version: "1" }, capabilities: { experimentalApi: true } });
    this.notify("initialized", {});
  }
  async kill() {
    this.child.kill("SIGKILL");
    await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
  }
}

try {
  const first = new Rpc(); await first.init();
  const threadResult = await first.request("thread/start", { model: "fixture-model", approvalPolicy: "never", sandbox: "read-only" });
  const threadId = threadResult?.thread?.id ?? threadResult?.threadId;
  if (!threadId) throw new Error(`no thread id: ${JSON.stringify(threadResult)}`);
  const turnResult = await first.request("turn/start", { threadId, input: [{ type: "text", text: "wait forever" }] });
  const turnId = turnResult?.turn?.id ?? turnResult?.turnId;
  if (!turnId) throw new Error(`no turn id: ${JSON.stringify(turnResult)}`);
  await Bun.sleep(1500);
  await first.kill();

  const second = new Rpc(); await second.init();
  try { await second.request("thread/resume", { threadId, model: "fixture-model", approvalPolicy: "never", sandbox: "read-only" }); } catch {}
  let observed: any;
  let method = "thread/turns/list";
  try {
    observed = await second.request(method, { threadId, limit: 100, sortDirection: "desc", itemsView: "full" });
  } catch (error) {
    method = "thread/read";
    observed = await second.request(method, { threadId, includeTurns: true });
  }
  const turns = observed?.data ?? observed?.thread?.turns ?? [];
  const turn = turns.find((candidate: any) => candidate.id === turnId) ?? null;
  if (method !== "thread/turns/list") throw new Error(`real codex lacks thread/turns/list: ${method}`);
  if (turn?.status !== "interrupted") throw new Error(`stopped turn stayed ${turn?.status ?? "missing"}`);
  const completedAt = typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt)
    ? "present"
    : "null";
  console.log(`REAL_CODEX_STOP version=${process.env.CODEX_PROBE_VERSION} method=${method} status=${turn.status} completedAt=${completedAt}`);
  await second.kill();
} finally {
  hanging.stop(true);
}
