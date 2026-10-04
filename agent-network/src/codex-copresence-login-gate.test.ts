import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHomeLoginState, describeCodexNeedsLogin, NEEDS_LOGIN_EXIT_CODE } from "./codex-copresence-login-gate";
import { codexLoginFactsOfHome } from "./codex-node-login";

const withHome = (fn: (d: string) => void) => {
  const d = mkdtempSync(join(tmpdir(), "t535-login-"));
  try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};
const auth = (d: string, v: unknown) => writeFileSync(join(d, "auth.json"), typeof v === "string" ? v : JSON.stringify(v));

describe("#535 codex co-presence login gate (judged by the #529 helper)", () => {
  test("agrees with codexLoginFactsOfHome on every auth.json shape", () => {
    const shapes: unknown[] = [
      { tokens: { refresh_token: "r-fake" } }, { tokens: { access_token: "a-fake" } }, { OPENAI_API_KEY: "sk-fake" },
      {}, { OPENAI_API_KEY: "  ", tokens: { refresh_token: "" } }, "not json",
    ];
    for (const shape of shapes) withHome((d) => {
      auth(d, shape);
      const helper = codexLoginFactsOfHome(d).loggedIn;
      expect(codexHomeLoginState(d, {}).state).toBe(helper ? "logged-in" : "needs-login");
    });
    withHome((d) => expect(codexHomeLoginState(d, {})).toEqual({ state: "needs-login", reason: "auth.json does not exist" }));
  });
  test("keyring credential store or an env API key = unknown (does not block); a file store still decides", () => {
    withHome((d) => {
      writeFileSync(join(d, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
      expect(codexHomeLoginState(d, {}).state).toBe("unknown");
      writeFileSync(join(d, "config.toml"), "cli_auth_credentials_store = 'auto'\n");
      expect(codexHomeLoginState(d, {}).state).toBe("unknown");
      writeFileSync(join(d, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      expect(codexHomeLoginState(d, {}).state).toBe("needs-login");
      expect(codexHomeLoginState(d, { OPENAI_API_KEY: "sk-fake" }).state).toBe("unknown");
      expect(codexHomeLoginState(d, { CODEX_API_KEY: " " }).state).toBe("needs-login");
    });
  });
  test("the needs-login text names the state, the exact CODEX_HOME and the command; never 就绪, never a token", () => {
    withHome((d) => {
      auth(d, { tokens: { refresh_token: "" } });
      const lines = describeCodexNeedsLogin({ alias: "cx one", codexHome: d, reason: "auth.json has no ChatGPT token and no API key" }).join("\n");
      expect(lines).toContain("needs-login");
      expect(lines).toContain(`CODEX_HOME=${d} codex login --device-auth`);
      expect(lines).toContain("anet node start 'cx one'");
      expect(lines).not.toContain("就绪");
      expect(NEEDS_LOGIN_EXIT_CODE).toBe(3);
    });
  });
});
