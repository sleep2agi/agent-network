// #1749 — Windows 真机门失败时的证据形状。
//
// 之前 run.ps1 的 catch 只写 `result: FAIL` + 自己抛的那句 "real Windows journey failed",
// artifact 里 331 字节,没有任何能定位的信息(ConPTY exit 1 发生在 10.5s,与 180s 超时
// 无关 —— 这个事实当时只能从 job 时长反推)。
//
// 这里给 journey 一个统一的失败证据:阶段名、错误、ConPTY 退出码/耗时/输出尾巴,
// 全部先脱敏再落盘。脱敏不复用 agent-node 的 credential-redaction.ts(那是 TS,
// journey 用 node 直接跑 .mjs),规则照它的形状:token 前缀、Bearer、sk- 密钥、
// 以及本次 run 的私有路径与已知秘密字面量。
const TOKEN_SHAPES = [
  /\b[aun]tok_[A-Za-z0-9._-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/g,
];

export function redactForArtifact(text, { secrets = [], paths = [] } = {}) {
  let s = String(text ?? "");
  for (const secret of secrets.filter(x => typeof x === "string" && x.length >= 6)) s = s.split(secret).join("<redacted-secret>");
  for (const p of paths.filter(x => typeof x === "string" && x.length >= 4)) {
    s = s.split(p).join("<private-path>");
    s = s.split(p.replaceAll("\\", "/")).join("<private-path>");
  }
  for (const re of TOKEN_SHAPES) s = s.replace(re, "<redacted-token>");
  return s;
}

/** 输出尾巴:去掉 ANSI/控制序列后取最后 maxChars 个字符。ConPTY 重绘不算证据,但
 *  最后几行往往就是报错本身。 */
export function outputTail(out, maxChars = 2000) {
  const plain = String(out ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
  return plain.length > maxChars ? plain.slice(plain.length - maxChars) : plain;
}

/** 把 terminal() 的失败塞进 Error,journey 的 catch 直接读。 */
export function attachConptyDiag(error, { exitCode, elapsedMs, out, timedOut }) {
  error.conpty = { exitCode: exitCode ?? null, elapsedMs, timedOut: Boolean(timedOut), outputTail: outputTail(out) };
  return error;
}

export function failureEvidence({ error, phase, base = {}, redact = { secrets: [], paths: [] } }) {
  const r = text => redactForArtifact(text, redact);
  return {
    ...base,
    result: "FAIL",
    phase: phase ?? "unknown",
    error: { name: error?.name ?? "Error", message: r(error?.message ?? String(error)), stack: r(error?.stack ?? "").split("\n").slice(0, 8).join("\n") },
    conpty: error?.conpty ? { ...error.conpty, outputTail: r(error.conpty.outputTail) } : null,
    failedAt: new Date().toISOString(),
  };
}

export function failureReport(ev) {
  const c = ev.conpty ? `conpty: exit=${ev.conpty.exitCode} elapsedMs=${ev.conpty.elapsedMs} timedOut=${ev.conpty.timedOut}\n--- output tail ---\n${ev.conpty.outputTail}\n` : "";
  return `test1212 Windows real Codex protected manual gate\nresult: FAIL\nphase: ${ev.phase}\nsource: ${ev.sourceSha}\nerror: ${ev.error.message}\n${c}NOT-IN-CI: credential-bearing manual gate; evidence scrubbed.\n`;
}
