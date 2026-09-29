// 节点运行日志只读查看 —— 脱敏(哨兵一个都不能活下来)、参数收口、行解析 / 时间戳、
// 过滤(grep 在脱敏后匹配)、文件选取(没有客户端路径)、门铃 ack。
// 跑法:cd agent-node && bun test src/runtime/node-logs.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOGS_DEFAULT_LINES,
  LOGS_MAX_LINES,
  LOG_REDACTED,
  createLogRedactor,
  filterLogLines,
  lineTimestamp,
  nodeLogFiles,
  parseLogChunk,
  parseLogsTailParams,
  tailNodeLogs,
} from "./node-logs";
import { processRulesFileRequests } from "./rules-file";

const cleanup: string[] = [];
afterAll(async () => {
  for (const d of cleanup) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
async function tmp(prefix: string): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanup.push(d);
  return d;
}

// 每个哨兵都是一段独一无二、不会自然出现的字符;断言:脱敏后的全文里一个都找不到。
const S = {
  ntok: "ntok_SENTINELntok0001aaaa",
  utokShort: "utok_S2",
  bearer: "SENTINELbearer0002bbbbbbbb",
  authBasic: "U0VOVElORUxiYXNpYzAwMDM=",
  authRaw: "SENTINELauthraw0004",
  envToken: "SENTINELenvtoken0005cccc",
  envKey: "SENTINELenvkey0006dddd",
  envSecret: "SENTINELenvsecret0007",
  envPassword: "SENTINELpw0008",
  jsonApiKey: "SENTINELjsonapikey0009",
  jsonAccessToken: "SENTINELaccesstoken0010",
  camel: "SENTINELcamel0011eeee",
  hexAfterKey: "5e4e54494e454c6865783030313200000000ffff",
  b64AfterKey: "U0VOVElORUxiNjQwMDEzZmZmZmZmZmZmZmZmZg==",
  jwt: "eyJTRU5USU5FTGp3dDAwMTQ.eyJzdWIiOiJzZW50aW5lbCJ9.U0VOVElORUxzaWcwMDE0",
  sk: "sk-SENTINELsk0015ffffffffff",
  xai: "xai-SENTINELxai0016gggggggg",
  knownValue: "plainlookingvalue0017",
  processEnv: "SENTINELprocessenv0018",
};

const PLANTED = [
  `[10:00:01] [INFO ] [node-a] connected with ${S.ntok}`,
  `[10:00:02] [INFO ] [node-a] short test token ${S.utokShort} accepted`,
  `[10:00:03] [WARN ] [node-a] retry with Authorization: Bearer ${S.bearer}`,
  `[10:00:04] [WARN ] [node-a] headers {"Authorization":"Basic ${S.authBasic}","x":1}`,
  `[10:00:05] [INFO ] [node-a] authorization=${S.authRaw}`,
  `[10:00:06] [INFO ] [node-a] env COMMHUB_TOKEN=${S.envToken} OPENAI_API_KEY=${S.envKey}`,
  `[10:00:07] [INFO ] [node-a] MY_SECRET="${S.envSecret}" DB_PASSWORD: ${S.envPassword}`,
  `[10:00:08] [ERROR] [node-a] body {"api_key":"${S.jsonApiKey}","accessToken":'${S.jsonAccessToken}'}`,
  `[10:00:09] [INFO ] [node-a] clientSecret=${S.camel}`,
  `[10:00:10] [INFO ] [node-a] signing key ${S.hexAfterKey}`,
  `[10:00:11] [INFO ] [node-a] refresh_token ${S.b64AfterKey}`,
  `[10:00:12] [INFO ] [node-a] id_token=${S.jwt} and raw ${S.jwt}`,
  `[10:00:13] [INFO ] [node-a] provider says ${S.sk} / ${S.xai}`,
  `[10:00:14] [INFO ] [node-a] echo ${S.knownValue}`,
  `[10:00:15] [INFO ] [node-a] from env ${S.processEnv}`,
];

const redactor = createLogRedactor({
  knownValues: [S.knownValue],
  env: { SOME_SERVICE_TOKEN_VALUE: S.processEnv, HOME: "/home/user", PATH: "/usr/bin" },
});

describe("redactor", () => {
  test("no planted sentinel survives", () => {
    const out = PLANTED.map((l) => redactor.redact(l)).join("\n");
    const survivors = Object.entries(S).filter(([, v]) => out.includes(v)).map(([k]) => k);
    expect(survivors).toEqual([]);
    // 也不能只剩一段可识别的尾巴
    expect(out).not.toMatch(/SENTINEL/);
    expect(out).not.toMatch(/U0VOVElORU/);
  });

  test("each planted line was changed and carries the placeholder", () => {
    for (const l of PLANTED) {
      const r = redactor.redact(l);
      expect(r).not.toBe(l);
      expect(r).toContain(LOG_REDACTED);
    }
  });

  test("keeps the key names and the ordinary text readable", () => {
    expect(redactor.redact(PLANTED[5])).toContain("COMMHUB_TOKEN=");
    expect(redactor.redact(PLANTED[5])).toContain("OPENAI_API_KEY=");
    expect(redactor.redact(PLANTED[2])).toContain("retry with Authorization");
    expect(redactor.redact(`[10:00:00] [INFO ] [node-a] task started id=rf_1234 status=ok`)).toBe(`[10:00:00] [INFO ] [node-a] task started id=rf_1234 status=ok`);
  });

  test("never double-wraps a value the base redactor already masked", () => {
    for (const l of ["[x] session_key=abcdef", "DB_PASSWORD=hunter22", "refresh_token abcdefghijklmnopqrstuvwxyz"]) {
      const r = redactor.redact(l);
      expect(r).not.toContain(`${LOG_REDACTED}]`);
      expect(r).not.toContain("[[");
    }
  });

  test("positive control: a line without secrets is untouched, a known value is caught mid-word", () => {
    const clean = "[10:00:00] [INFO ] [node-a] ← SSE rules_file doorbell";
    expect(redactor.redact(clean)).toBe(clean);
    expect(redactor.redact(`x${S.knownValue}y`)).not.toContain(S.knownValue);
  });
});

describe("params", () => {
  test("defaults, clamps and drops junk", () => {
    expect(parseLogsTailParams("")).toEqual({ lines: LOGS_DEFAULT_LINES });
    expect(parseLogsTailParams("not json")).toEqual({ lines: LOGS_DEFAULT_LINES });
    expect(parseLogsTailParams(JSON.stringify({ lines: 99999 })).lines).toBe(LOGS_MAX_LINES);
    expect(parseLogsTailParams(JSON.stringify({ lines: 0 })).lines).toBe(LOGS_DEFAULT_LINES);
    expect(parseLogsTailParams(JSON.stringify({ level: "debug" })).level).toBeUndefined();
    expect(parseLogsTailParams(JSON.stringify({ level: "warn", grep: "x", since_ts: 5 }))).toEqual({ lines: LOGS_DEFAULT_LINES, level: "warn", grep: "x", since_ts: 5 });
    // 路径类字段一律忽略 —— 这条链路没有路径参数
    expect(parseLogsTailParams(JSON.stringify({ path: "/etc/passwd", file: "../x" }))).toEqual({ lines: LOGS_DEFAULT_LINES });
  });
});

describe("parse", () => {
  test("lineTimestamp picks the local time inside the file's UTC day", () => {
    const t = lineTimestamp({ y: 2026, m: 9, d: 29 }, 10, 0, 1)!;
    expect(t).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 29));
    expect(t).toBeLessThan(Date.UTC(2026, 8, 30));
    expect(new Date(t).getHours()).toBe(10);
    expect(lineTimestamp(null, 1, 2, 3)).toBeNull();
  });

  test("levels, continuation lines, CRLF and byte-offset keys", () => {
    const chunk = "[10:00:01] [INFO ] [a] one\r\n[10:00:02] [ERROR] [a] boom\r\n    at stack (x.ts:1)\r\n[10:00:03] [WARN ] [a] 中文\r\n";
    const lines = parseLogChunk("2026-09-29.log", chunk, 0);
    expect(lines.map((l) => l.level)).toEqual(["info", "error", "error", "warn"]);
    expect(lines[2].ts).toBe(lines[1].ts);
    expect(lines.every((l) => !l.text.includes("\r"))).toBe(true);
    expect(lines[0].key).toBe("2026-09-29.log:0");
    expect(lines[1].key).toBe(`2026-09-29.log:${Buffer.byteLength("[10:00:01] [INFO ] [a] one\n")}`);
  });

  test("reading from the middle drops the first partial line", () => {
    const lines = parseLogChunk("2026-09-29.log", "tial line\n[10:00:02] [INFO ] [a] whole\n", 100);
    expect(lines.length).toBe(1);
    expect(lines[0].text).toContain("whole");
    expect(lines[0].key).toBe(`2026-09-29.log:${100 + "tial line\n".length}`);
  });
});

describe("filter", () => {
  const lines = parseLogChunk("2026-09-29.log", [
    "[10:00:01] [INFO ] [a] alpha",
    "[10:00:02] [WARN ] [a] Beta warn",
    "[10:00:03] [ERROR] [a] gamma error",
    "[10:00:04] [INFO ] [a] delta beta",
  ].join("\n") + "\n", 0);

  test("level is an exact match, grep is case-insensitive, lines keeps the newest", () => {
    expect(filterLogLines(lines, { lines: 10, level: "warn" }).lines.map((l) => l.text)).toEqual(["[10:00:02] [WARN ] [a] Beta warn"]);
    expect(filterLogLines(lines, { lines: 10, grep: "BETA" }).matched).toBe(2);
    const r = filterLogLines(lines, { lines: 2 });
    expect(r.matched).toBe(4);
    expect(r.lines.map((l) => l.text.slice(-5))).toEqual(["error", " beta"]);
  });

  test("since_ts is inclusive (same-second lines come back; the client de-dups by key)", () => {
    const r = filterLogLines(lines, { lines: 10, since_ts: lines[2].ts! });
    expect(r.lines.length).toBe(2);
  });

  test("grep cannot probe a redacted secret", () => {
    const red = parseLogChunk("2026-09-29.log", redactor.redact(PLANTED[0]) + "\n", 0);
    expect(filterLogLines(red, { lines: 10, grep: S.ntok.slice(5, 16) }).matched).toBe(0);
    expect(filterLogLines(red, { lines: 10, grep: "connected with" }).matched).toBe(1);
    expect(filterLogLines(red, { lines: 10, grep: LOG_REDACTED }).matched).toBe(1);
  });
});

describe("files and tail", () => {
  test("picks the newest two dated logs; start-*.log only when no dated log", async () => {
    const d = await tmp("anet-logs-");
    await fs.writeFile(path.join(d, "2026-09-27.log"), "x\n");
    await fs.writeFile(path.join(d, "2026-09-28.log"), "x\n");
    await fs.writeFile(path.join(d, "2026-09-29.log"), "x\n");
    await fs.writeFile(path.join(d, "start-acp.log"), "x\n");
    await fs.writeFile(path.join(d, "other.txt"), "x\n");
    expect(await nodeLogFiles(d)).toEqual(["2026-09-28.log", "2026-09-29.log"]);
    const e = await tmp("anet-logs-start-");
    await fs.writeFile(path.join(e, "start-old.log"), "x\n");
    await new Promise((r) => setTimeout(r, 15));
    await fs.writeFile(path.join(e, "start-new.log"), "x\n");
    expect(await nodeLogFiles(e)).toEqual(["start-new.log"]);
    expect(await nodeLogFiles(path.join(e, "missing"))).toEqual([]);
  });

  test("a symlinked log is not followed", async () => {
    const d = await tmp("anet-logs-link-");
    const outside = await tmp("anet-logs-outside-");
    await fs.writeFile(path.join(outside, "secret.txt"), "[10:00:00] [INFO ] [x] OUTSIDE-CONTENT\n");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(d, "2026-09-29.log"));
    const r = await tailNodeLogs(d, { lines: 10 }, redactor);
    expect(r.lines.length).toBe(0);
  });

  test("end to end: planted file → redacted, filtered, file names only", async () => {
    const d = await tmp("anet-logs-e2e-");
    await fs.writeFile(path.join(d, "2026-09-29.log"), PLANTED.join("\n") + "\n");
    const r = await tailNodeLogs(d, { lines: 500 }, redactor, 123);
    expect(r.files).toEqual(["2026-09-29.log"]);
    expect(r.lines.length).toBe(PLANTED.length);
    expect(r.now_ts).toBe(123);
    const json = JSON.stringify(r);
    expect(Object.values(S).filter((v) => json.includes(v))).toEqual([]);
    expect(json).not.toContain(d);
    const errs = await tailNodeLogs(d, { lines: 500, level: "error" }, redactor);
    expect(errs.lines.length).toBe(1);
  });
});

describe("doorbell", () => {
  test("logs_tail acks done with redacted JSON; a process without a log dir acks failed", async () => {
    const d = await tmp("anet-logs-door-");
    await fs.writeFile(path.join(d, "2026-09-29.log"), PLANTED.join("\n") + "\n");
    const acks: any[] = [];
    let queue = [
      { request_id: "rf_1", op: "logs_tail", content: JSON.stringify({ lines: 5, grep: "node-a" }) },
      { request_id: "rf_2", op: "logs_tail", content: "{}" },
    ];
    const callCommHub = async (method: string, params: any) => {
      if (method === "get_rules_file_request") return { ok: true, request: queue.shift() ?? null };
      acks.push(params);
      return { ok: true };
    };
    const logs: string[] = [];
    await processRulesFileRequests({ callCommHub, runtime: "codex", workDir: d, log: (m) => logs.push(m), warn: (m) => logs.push(m), logsTail: (raw) => tailNodeLogs(d, parseLogsTailParams(raw), redactor) });
    expect(acks[0].status).toBe("done");
    expect(acks[0].file_name).toBe("logs");
    const body = JSON.parse(acks[0].content);
    expect(body.lines.length).toBe(5);
    expect(Object.values(S).filter((v) => acks[0].content.includes(v))).toEqual([]);
    // 过滤词不进节点自己的日志
    expect(logs.join("\n")).not.toContain("node-a");

    queue = [{ request_id: "rf_3", op: "logs_tail", content: "{}" }];
    acks.length = 0;
    await processRulesFileRequests({ callCommHub, runtime: "codex", workDir: d, log: () => {}, warn: () => {} });
    expect(acks[0].status).toBe("failed");
    expect(acks[0].file_name).toBe("logs");
  });
});
