// 2026-11-11 安全排查：生产 Hub 的公开注册没有开关（任何人都能注册、领令牌、按令牌限额上传）。
// COMMHUB_REGISTRATION=closed 关掉注册；不设 = 旧行为。库里还没有用户时（装机第一个 admin）照常放行。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-regswitch-"));
let BASE = "";
let hub: any = null;

const reg = (username: string) => fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password: "RegSwitchPassw0rd!" }),
}).then(async r => ({ status: r.status, body: await r.json() as any }));

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  delete process.env.COMMHUB_REGISTRATION;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  delete process.env.COMMHUB_REGISTRATION;
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("COMMHUB_REGISTRATION", () => {
  test("unset: registration stays open (unchanged)", async () => {
    register(`seed_${Date.now()}`, "RegSwitchPassw0rd!");
    const r = await reg(`open_${Date.now()}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test("closed: new sign-ups get 403 registration_closed; login still works", async () => {
    const name = `before_${Date.now()}`;
    expect((await reg(name)).status).toBe(200);
    process.env.COMMHUB_REGISTRATION = "closed";
    try {
      const r = await reg(`late_${Date.now()}`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("registration_closed");
      const login = await fetch(`${BASE}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, password: "RegSwitchPassw0rd!" }),
      });
      expect(login.status).toBe(200);
    } finally {
      delete process.env.COMMHUB_REGISTRATION;
    }
  });
});
