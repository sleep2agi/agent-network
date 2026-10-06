/**
 * Board #672. Fake key, fake upstream. The product helper decides whether
 * an api_retry aborts the SDK child. Attempt 1 is the CLI's token refresh
 * and must be allowed to succeed. A 401 that is still a 401 on the next
 * attempt aborts. A 429 must still be retried by the CLI.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_AUTH_USER_TEXT,
  CLAUDE_LOGIN_STATUS_HINT,
  claudeApiRetryIsAuthFailure,
  claudeAuthRetryDecision,
  claudeAuthStatusReport,
  claudeThrownErrorDisposition,
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

  assert(auth({ error: "authentication_failed", error_status: 401 }) === true, "401 authentication_failed is an auth retry");
  assert(auth({ error: "unknown", error_status: 401 }) === true, "401 unknown is an auth retry");
  assert(auth({ error_status: 403 }) === true, "403 is an auth retry");
  assert(auth({ error: "authentication_failed", error_status: null }) === true, "authentication_failed without a status is an auth retry");
  const retry = (attempt: number, extra: Partial<ClaudeApiRetryLike> = {}) =>
    claudeAuthRetryDecision({ type: "system", subtype: "api_retry", attempt, error: "authentication_failed", error_status: 401, ...extra });
  assert(retry(1).action === "continue", "attempt 1 must leave the CLI's token refresh alone");
  assert(retry(2).action === "abort", "attempt 2 of a 401 must abort");
  assert(claudeAuthRetryDecision({ type: "system", subtype: "api_retry", attempt: 2, error: "rate_limit", error_status: 429 }).action === "continue", "attempt 2 of a 429 must not abort");
  assert(claudeAuthRetryDecision({ type: "system", subtype: "api_retry", attempt: 2, error: "billing_error", error_status: 403 }).action === "continue", "billing 403 must not abort");
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

  // SDK 0.3.289: Error(`Claude Code returned an error result: ${result}`).
  // The prefix is long enough to eat an 80-character slice. These are the
  // strings the CLI actually throws, not the short result text underneath.
  const sdkError = (result: string) => `Claude Code returned an error result: ${result}`;
  const region = sdkError("Failed to authenticate. API Error: 403 Request not allowed");
  const permission = sdkError("Failed to authenticate. API Error: 403 Your API key does not have permission to perform this action");
  const revoked = sdkError("Failed to authenticate. API Error: 403 OAuth token has been revoked");
  const invalidKey = sdkError("Failed to authenticate. API Error: 401 invalid x-api-key");
  const dead = claudeThrownErrorDisposition(invalidKey, false);
  assert(dead.action === "stop" && dead.markLoginDead === true, "a thrown 401 marks the login dead");
  assert(dead.action === "stop" && dead.userText.includes("401") && dead.userText.includes("invalid x-api-key"), "a thrown 401 keeps the vendor text");
  assert(dead.action === "stop" && dead.userText.includes("refresh API key"), "a thrown 401 still says to refresh the key");
  assert(dead.action === "stop" && !dead.userText.includes("Claude Code returned an error result"), "a thrown 401 drops the SDK prefix");
  assert(dead.action === "stop" && dead.userText !== CLAUDE_AUTH_USER_TEXT, "a thrown 401 is not replaced with only the login sentence");
  const revokedThrow = claudeThrownErrorDisposition(revoked, false);
  assert(revokedThrow.action === "stop" && revokedThrow.markLoginDead === true, "a thrown revoked 403 marks the login dead");
  assert(revokedThrow.action === "stop" && revokedThrow.userText.includes("revoked"), "a thrown revoked 403 keeps the vendor text");
  assert(revokedThrow.action === "stop" && revokedThrow.userText.includes("refresh API key"), "a revoked 403 still says to refresh the key");
  const regionThrow = claudeThrownErrorDisposition(region, false);
  assert(regionThrow.action === "stop" && regionThrow.markLoginDead === false, "a region 403 must not mark the login dead");
  assert(regionThrow.action === "stop" && regionThrow.userText.includes("Request not allowed") && !regionThrow.userText.includes("请重新登录"), "a region 403 keeps its own reason");
  assert(regionThrow.action === "stop" && !regionThrow.userText.includes("refresh API key"), "a region 403 must not say to refresh the key");
  assert(regionThrow.action === "stop" && !regionThrow.userText.includes("403 Req)"), "a region 403 must not be sliced down to 403 Req");
  const permissionThrow = claudeThrownErrorDisposition(permission, false);
  assert(permissionThrow.action === "stop" && permissionThrow.markLoginDead === false, "a permission 403 must not mark the login dead");
  assert(permissionThrow.action === "stop" && permissionThrow.userText.includes("does not have permission"), "a permission 403 keeps its own reason");
  assert(permissionThrow.action === "stop" && !permissionThrow.userText.includes("refresh API key"), "a permission 403 must not say to refresh the key");
  assert(permissionThrow.action === "stop" && !permissionThrow.userText.includes("403 You)"), "a permission 403 must not be sliced down to 403 You");
  const aborted = claudeThrownErrorDisposition(region, true);
  assert(aborted.action === "stop" && aborted.userText === CLAUDE_AUTH_USER_TEXT, "aborted attempt must not be reclassified");
  assert(claudeThrownErrorDisposition("model output was empty", false).action === "fallthrough", "a non-auth error falls through");
  console.log("PURE_OK");
}

function wiring(): void {
  // Static guard only. This does not execute processWithClaude. The two
  // branches below are pinned as contiguous source so deleting the abort,
  // skipping the catch, or not setting authAbortedThisAttempt goes red.
  const cli = readFileSync("/src/cli.ts", "utf8");
  assert(cli.includes("const authDecision = claudeAuthRetryDecision(m);"), "cli wiring missing");
  assert(cli.includes("claudeAuthStatusReport({"), "status wiring missing");
  assert(!cli.includes("CLAUDE_CODE_MAX_RETRIES"), "cli must not set CLAUDE_CODE_MAX_RETRIES");
  const marks = cli.split("markClaudeLoginDead();").length - 1;
  assert(marks === 2, `markClaudeLoginDead count ${marks}, expected 2`);
  if (!cli.includes("authAbortedThisAttempt = true;")) {
    fail("authAbortedThisAttempt is not set on abort");
  }
  const abortBranch = [
    'if (authDecision.action === "abort") {',
    "              authAbortedThisAttempt = true;",
    '              log(`[claude] ✗ auth api_retry attempt=${m.attempt ?? "none"} status=${m.error_status ?? "none"} error=${m.error ?? "none"}; aborting the attempt`);',
    "              markClaudeLoginDead();",
    "              ac.abort();",
    "              return authDecision.userText;",
  ].join("\n");
  assert(cli.includes(abortBranch), "cli abort branch was removed");
  const catchBranch = [
    "const thrown = claudeThrownErrorDisposition(msg, authAbortedThisAttempt);",
    '      if (thrown.action === "stop") {',
    "        if (!authAbortedThisAttempt) {",
    "          log(`[claude] ✗ FATAL: vendor API auth failed (${msg.slice(0, 150)})`);",
    "          log(`[anet] FATAL: Vendor API auth failed — ${msg.slice(0, 100)}`);",
    "          log(`[anet]        ${remediationHint(msg)}`);",
    "        }",
    "        if (thrown.markLoginDead) markClaudeLoginDead();",
    "        return thrown.userText;",
  ].join("\n");
  assert(cli.includes(catchBranch), "cli catch branch was removed");
  console.log("WIRING_OK");
}

interface Hit { method: string; path: string; status: number; at: number }

function messagePosts(hits: Hit[]): Hit[] {
  return hits.filter((h) => h.method === "POST" && h.path.startsWith("/v1/messages"));
}

function okSse(): string {
  const events: Array<[string, unknown]> = [
    ["message_start", {
      type: "message_start",
      message: {
        id: "msg_test672", type: "message", role: "assistant", content: [],
        model: "claude-sonnet-4-5-20250929", stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }],
    ["content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "text", text: "" },
    }],
    ["content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: "ok" },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function listen(kind: "auth" | "capacity" | "recover"): Promise<{ port: number; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url || "/";
    // Startup probe. Not an API retry, and not a 401.
    const prelude = req.method === "HEAD" || path.startsWith("/api/hello");
    const priorMessages = hits.filter((h) => h.method === "POST" && h.path.startsWith("/v1/messages")).length;
    const recoverOk = kind === "recover" && !prelude && priorMessages >= 1;
    const status = prelude || recoverOk ? 200 : (kind === "capacity" ? 429 : 401);
    req.resume();
    hits.push({ method: req.method || "?", path, status, at: Date.now() });
    console.log(`HIT ${hits.length} ${req.method} ${path} -> ${status}`);
    const body = prelude
      ? JSON.stringify({ status: "ok" })
      : recoverOk
        ? okSse()
        : kind === "capacity"
          ? JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit" } })
          : JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    // Real Anthropic 401s omit retry-after. Capacity keeps a 1s hint so the
    // second 429 is observable quickly. Recover's second response is 200.
    const headers: Record<string, string | number> = {
      "content-type": recoverOk ? "text/event-stream" : "application/json",
      connection: "close",
      "content-length": Buffer.byteLength(body),
    };
    if (!prelude && !recoverOk && kind === "capacity") headers["retry-after"] = "1";
    res.writeHead(status, headers);
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

async function runTurn(kind: "auth" | "capacity" | "recover"): Promise<{ text: string; hits: Hit[]; elapsedMs: number }> {
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
  const budgetMs = kind === "capacity" ? 45_000 : 90_000;
  const killer = setTimeout(() => ac.abort(), budgetMs);
  // The 180s bug is the retry, not process startup. A dead key must come
  // back within seconds of the first 401, after the one refresh attempt.
  const tooSlow = setInterval(() => {
    const first = messagePosts(mock.hits)[0];
    if (kind === "auth" && first && Date.now() - first.at > 15_000) ac.abort();
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
      const m = message as ClaudeApiRetryLike & { subtype?: string; result?: string };
      if (m.type === "system" && m.subtype === "api_retry") {
        sawRetry = true;
        console.log(`api_retry ${JSON.stringify({
          attempt: m.attempt,
          error_status: m.error_status ?? null,
          error: m.error ?? null,
          no_response: m.no_response != null,
        })}`);
      }
      if (m.type === "result" && m.subtype === "success" && typeof m.result === "string") {
        text = m.result;
        break;
      }
      // Same function cli.ts calls. Do not reimplement the attempt check here.
      const decision = claudeAuthRetryDecision(m);
      if (decision.action === "abort") {
        ac.abort();
        text = decision.userText;
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
  if (kind === "recover") {
    const second = posts[1];
    if (text === CLAUDE_AUTH_USER_TEXT || !text.includes("ok") || posts.length < 2 || firstPost?.status !== 401 || second?.status !== 200) {
      await mock.close();
      fail(`a 401 then 200 was treated as a dead login (text=${JSON.stringify(text).slice(0, 120)} posts=${posts.length} elapsed=${elapsedMs} paths=${paths()})`);
    }
    await mock.close();
    console.log(`RECOVER_OK elapsed=${elapsedMs} posts=${posts.length}`);
    return { text, hits: mock.hits, elapsedMs };
  }
  if (kind === "auth") {
    // No retry-after, same shape as a real 401. Attempt 1 is allowed, so
    // there is a second POST, then abort. Measured on SDK 0.3.289: those
    // two, plus one more inside the ~2s SIGTERM window, then silence.
    // More than 3 is the long retry loop.
    if (text !== CLAUDE_AUTH_USER_TEXT || posts.length < 2 || posts.length > 3 || firstPost?.status !== 401 || sincePost > 15_000) {
      await mock.close();
      fail(`auth retry was not stopped (text=${JSON.stringify(text).slice(0, 120)} posts=${posts.length} sawRetry=${sawRetry} sincePost=${sincePost} elapsed=${elapsedMs} paths=${paths()})`);
    }
    const atReturn = mock.hits.length;
    await new Promise((r) => setTimeout(r, 15_000));
    if (mock.hits.length !== atReturn) {
      await mock.close();
      fail(`auth retry was not stopped (hits=${mock.hits.length} atReturn=${atReturn} posts=${messagePosts(mock.hits).length} paths=${paths()})`);
    }
    await mock.close();
    console.log(`AUTH_OK elapsed=${elapsedMs} posts=${messagePosts(mock.hits).length}`);
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
else if (mode === "auth" || mode === "capacity" || mode === "recover") await runTurn(mode);
else fail(`unknown mode ${mode}`);
