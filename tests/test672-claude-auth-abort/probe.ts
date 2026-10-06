/**
 * Board #672. Fake key, fake upstream. The product helper decides whether
 * an api_retry aborts the SDK child. A 401 must return the readable error
 * in seconds and the upstream must not see another request. A 429 must
 * still be retried by the CLI.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_AUTH_USER_TEXT,
  CLAUDE_LOGIN_STATUS_HINT,
  claudeApiRetryIsAuthFailure,
  claudeAuthStatusReport,
  type ClaudeApiRetryLike,
} from "/src/claude-auth-retry.ts";

const FAKE_KEY = "sk-ant-test-invalid";

function fail(msg: string): never {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

function pure(): void {
  const auth = (extra: Partial<ClaudeApiRetryLike>) =>
    claudeApiRetryIsAuthFailure({ type: "system", subtype: "api_retry", ...extra });

  assert(auth({ error: "authentication_failed", error_status: 401 }) === true, "401 authentication_failed must abort");
  assert(auth({ error: "unknown", error_status: 401 }) === true, "401 unknown must abort");
  assert(auth({ error_status: 403 }) === true, "403 must abort");
  assert(auth({ error: "authentication_failed", error_status: null }) === true, "authentication_failed without a status must abort");
  assert(auth({ error: "rate_limit", error_status: 429 }) === false, "429 must not abort");
  assert(auth({ error: "overloaded", error_status: 529 }) === false, "529 must not abort");
  assert(auth({ error: "server_error", error_status: 503 }) === false, "5xx must not abort");
  assert(auth({ error: "billing_error", error_status: 403 }) === false, "billing 403 must not abort");
  assert(auth({ error: "authentication_failed", error_status: 401, no_response: { waited_ms: 1 } }) === false, "first-byte timeout must not abort");
  assert(claudeApiRetryIsAuthFailure({ type: "system", subtype: "init" }) === false, "init is not an auth retry");

  const running = "do the long thing that is still in flight";
  const held = claudeAuthStatusReport({
    status: "working",
    task: running,
    callerTask: running,
    inFlight: 1,
    loginDead: true,
  });
  assert(held.status === "working" && held.task === running, "in-flight caller text must stay");
  assert(held.task !== CLAUDE_LOGIN_STATUS_HINT, "in-flight report must not publish the login hint");

  const omitted = claudeAuthStatusReport({
    status: "error",
    task: undefined,
    callerTask: undefined,
    inFlight: 1,
    loginDead: true,
  });
  assert(omitted.status === "error" && omitted.task === undefined, "in-flight error report omits task");

  const idle = claudeAuthStatusReport({
    status: "idle",
    task: "目录不一致：留下的警告",
    callerTask: undefined,
    inFlight: 0,
    loginDead: true,
  });
  assert(idle.status === "error" && idle.task === CLAUDE_LOGIN_STATUS_HINT, "idle report must publish the login hint");

  const fresh = claudeAuthStatusReport({
    status: "idle",
    task: undefined,
    callerTask: undefined,
    inFlight: 0,
    loginDead: false,
  });
  assert(fresh.status === "idle" && fresh.task === undefined, "a live login does not rewrite idle");
  console.log("PURE_OK");
}

function wiring(): void {
  const cli = readFileSync("/src/cli.ts", "utf8");
  const block = "markClaudeLoginDead();\n              ac.abort();\n              return CLAUDE_AUTH_USER_TEXT;";
  assert(cli.includes(block), "cli wiring missing");
  assert(cli.includes("claudeAuthStatusReport({"), "status wiring missing");
  assert(!cli.includes("CLAUDE_CODE_MAX_RETRIES"), "cli must not set CLAUDE_CODE_MAX_RETRIES");
  const marks = cli.split("markClaudeLoginDead();").length - 1;
  assert(marks === 2, `markClaudeLoginDead count ${marks}, expected 2`);
  console.log("WIRING_OK");
}

interface Hit { method: string; path: string; status: number; at: number }

function messagePosts(hits: Hit[]): Hit[] {
  return hits.filter((h) => h.method === "POST" && h.path.startsWith("/v1/messages"));
}

function listen(kind: "auth" | "capacity"): Promise<{ port: number; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url || "/";
    // Startup probe. Not an API retry, and not a 401, so it cannot be
    // counted as the login failure the abort is supposed to stop.
    const prelude = req.method === "HEAD" || path.startsWith("/api/hello");
    const status = prelude ? 200 : (kind === "auth" ? 401 : 429);
    req.resume();
    hits.push({ method: req.method || "?", path, status, at: Date.now() });
    console.log(`HIT ${hits.length} ${req.method} ${path} -> ${status}`);
    const body = prelude
      ? JSON.stringify({ status: "ok" })
      : kind === "auth"
        ? JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })
        : JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit" } });
    // SDK 0.3.289 waits 2s after abort before SIGTERM. A 401 retry-after
    // shorter than that fires inside the window and looks like a leaked
    // retry. 8s is past the kill; the 15s grace below is past this delay,
    // so a child that was not actually stopped still shows up.
    const retryAfter = kind === "auth" ? "8" : "1";
    res.writeHead(status, {
      "content-type": "application/json",
      ...(prelude ? {} : { "retry-after": retryAfter }),
      connection: "close",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock listen failed"));
        return;
      }
      if (addr.port === 9200) {
        reject(new Error("refusing port 9200"));
        return;
      }
      resolve({
        port: addr.port,
        hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function runTurn(kind: "auth" | "capacity"): Promise<{ text: string; hits: Hit[]; elapsedMs: number }> {
  const mock = await listen(kind);
  const base = `http://127.0.0.1:${mock.port}`;
  delete process.env.CLAUDE_CODE_MAX_RETRIES;
  delete process.env.CLAUDE_CODE_RETRY_WATCHDOG;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.CI = "1";
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  const ac = new AbortController();
  const budgetMs = kind === "auth" ? 90_000 : 45_000;
  const killer = setTimeout(() => ac.abort(), budgetMs);
  // The 180s bug is the retry, not process startup. Once the upstream has
  // seen the first 401, the readable error has to come back within seconds.
  const tooSlow = setInterval(() => {
    const first = mock.hits[0];
    if (kind === "auth" && first && Date.now() - first.at > 10_000) ac.abort();
  }, 200);
  const t0 = Date.now();
  let text = "";
  let sawRetry = false;
  try {
    const messages = query({
      prompt: "Reply with the single word ok.",
      options: {
        model: "claude-sonnet-4-5-20250929",
        maxTurns: 1,
        permissionMode: "dontAsk",
        settingSources: [],
        abortController: ac,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_API_KEY: FAKE_KEY,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          CI: "1",
        },
        cwd: "/tmp",
        stderr: (data: string) => {
          const line = data.replaceAll(FAKE_KEY, "[redacted]").trim();
          if (line) console.log(`[stderr] ${line.slice(0, 300)}`);
        },
      },
    });
    for await (const message of messages) {
      const m = message as ClaudeApiRetryLike & { attempt?: number };
      if (m.type === "system" && m.subtype === "api_retry") {
        sawRetry = true;
        console.log(`api_retry ${JSON.stringify({
          attempt: m.attempt,
          error_status: m.error_status ?? null,
          error: m.error ?? null,
          no_response: m.no_response != null,
        })}`);
      }
      if (claudeApiRetryIsAuthFailure(m)) {
        ac.abort();
        text = CLAUDE_AUTH_USER_TEXT;
        break;
      }
      if (kind === "capacity" && messagePosts(mock.hits).length >= 2) {
        ac.abort();
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[query] ${msg.replaceAll(FAKE_KEY, "[redacted]").slice(0, 300)}`);
  } finally {
    clearTimeout(killer);
    clearInterval(tooSlow);
  }
  const elapsedMs = Date.now() - t0;
  const posts = messagePosts(mock.hits);
  const firstPost = posts[0];
  const sincePost = firstPost ? Date.now() - firstPost.at : elapsedMs;
  const paths = () => mock.hits.map((h) => `${h.method} ${h.path} ${h.status}`).join(",");
  if (kind === "auth") {
    // One 401 on the messages API, and the readable error is back within
    // seconds of that 401. Anything else means the retry was not stopped.
    if (text !== CLAUDE_AUTH_USER_TEXT || posts.length !== 1 || firstPost?.status !== 401 || sincePost > 10_000) {
      await mock.close();
      fail(`auth retry was not stopped (text=${JSON.stringify(text).slice(0, 120)} posts=${posts.length} sawRetry=${sawRetry} sincePost=${sincePost} elapsed=${elapsedMs} paths=${paths()})`);
    }
    const atReturn = mock.hits.length;
    // Longer than the 8s retry-after. The server stays open: closing it
    // would hide a background retry as a connection error.
    await new Promise((r) => setTimeout(r, 15_000));
    if (mock.hits.length !== atReturn || messagePosts(mock.hits).length !== 1) {
      await mock.close();
      fail(`auth retry was not stopped (hits=${mock.hits.length} atReturn=${atReturn} posts=${messagePosts(mock.hits).length} paths=${paths()})`);
    }
    await mock.close();
    console.log(`AUTH_OK elapsed=${elapsedMs} posts=1`);
    return { text, hits: mock.hits, elapsedMs };
  }
  if (text === CLAUDE_AUTH_USER_TEXT || posts.length < 2) {
    await mock.close();
    fail(`capacity retry was aborted (textSet=${text === CLAUDE_AUTH_USER_TEXT} posts=${posts.length} paths=${paths()} elapsed=${elapsedMs})`);
  }
  await mock.close();
  console.log(`CAPACITY_OK posts=${posts.length} elapsed=${elapsedMs}`);
  return { text, hits: mock.hits, elapsedMs };
}

const mode = process.argv[2] || "pure";
if (mode === "pure") pure();
else if (mode === "wiring") wiring();
else if (mode === "auth" || mode === "capacity") await runTurn(mode);
else fail(`unknown mode ${mode}`);
