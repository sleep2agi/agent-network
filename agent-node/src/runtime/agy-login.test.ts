import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgyLoginManager } from "./agy-login";

// 假 agy：stdout 打一段带 URL 的文字，然后读一行 stdin，按输入返回 0/1。
function fakeAgy(body = "ok"): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-agy-"));
  const file = join(dir, "agy");
  writeFileSync(file, `#!/usr/bin/env node
const mode = ${JSON.stringify(body)};
if (mode === "no-url") { process.stdout.write("still starting...\\n"); setTimeout(() => {}, 60_000); return; }
process.stdout.write("Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?state=abc\\n\\nThen paste the authorization code, and press Enter:\\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", d => {
  buf += d;
  const line = buf.split("\\n")[0];
  if (!buf.includes("\\n")) return;
  if (mode === "hang") { setTimeout(() => {}, 60_000); return; }
  if (line.trim() === "good") { process.exit(0); }
  process.stderr.write("invalid authorization code\\n");
  process.exit(1);
});
`, { mode: 0o755 });
  return file;
}

describe("agy login manager", () => {
  it("parses the URL and reports a session with a 5-minute expiry", async () => {
    const m = createAgyLoginManager({ binary: fakeAgy(), nextId: () => "L1" });
    const r = await m.start();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.loginId).toBe("L1");
    expect(r.session.url.startsWith("https://accounts.google.com/")).toBe(true);
    expect(r.session.expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    m.cancel();
  });

  it("submits the code to stdin and treats exit 0 as success", async () => {
    const m = createAgyLoginManager({ binary: fakeAgy() });
    const s = await m.start();
    if (!s.ok) throw new Error("start failed");
    await expect(m.submit(s.session.loginId, "good")).resolves.toEqual({ ok: true });
    expect(m.current()).toBeNull();
  });

  it("maps a rejected code to invalid_code", async () => {
    const m = createAgyLoginManager({ binary: fakeAgy() });
    const s = await m.start();
    if (!s.ok) throw new Error("start failed");
    await expect(m.submit(s.session.loginId, "bad")).resolves.toEqual({ ok: false, reason: "invalid_code" });
  });

  it("returns no_url when agy never prints a link", async () => {
    const m = createAgyLoginManager({ binary: fakeAgy("no-url"), urlTimeoutMs: 80 });
    await expect(m.start()).resolves.toEqual({ ok: false, reason: "no_url" });
  });

  it("times out when agy does not exit after the code", async () => {
    const m = createAgyLoginManager({ binary: fakeAgy("hang"), submitTimeoutMs: 120 });
    const s = await m.start();
    if (!s.ok) throw new Error("start failed");
    await expect(m.submit(s.session.loginId, "good")).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("expires a session that was never submitted", async () => {
    const m = createAgyLoginManager({ binary: fakeAgy(), ttlMs: 30 });
    const s = await m.start();
    if (!s.ok) throw new Error("start failed");
    await new Promise(r => setTimeout(r, 60));
    await expect(m.submit(s.session.loginId, "good")).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("keeps one live login at a time (new start cancels the old)", async () => {
    let n = 0;
    const m = createAgyLoginManager({ binary: fakeAgy(), nextId: () => `L${++n}` });
    const a = await m.start();
    if (!a.ok) throw new Error("first start failed");
    const b = await m.start();
    if (!b.ok) throw new Error("second start failed");
    await expect(m.submit(a.session.loginId, "good")).resolves.toEqual({ ok: false, reason: "expired" });
    await expect(m.submit(b.session.loginId, "good")).resolves.toEqual({ ok: true });
  });
});
