/**
 * #535 (audit P1-3) — a codex co-presence node without a login used to print
 * "✅ 就绪" while its TUI sat on Codex's sign-in page. Dashboard tasks then
 * stayed `delivered`, nothing showed in `anet logs`, and after 120 s the bridge
 * died (`waiting-for-tui-thread timed out`) and the node went offline. You
 * cannot create the first thread without logging in, so that window could
 * never be met.
 *
 * The launcher now asks this module BEFORE it starts any tmux session. A node
 * whose CODEX_HOME has no usable login is reported as `needs-login`, with the
 * exact command that logs THIS node in, and nothing is started — so there is no
 * bridge left to time out.
 *
 * "Usable login" is decided by the #529 helper (`codexLoginFactsOfHome` in
 * src/codex-node-login.ts), the same judgement `anet node codex login-status`
 * and the create/clone next-step use — login state is judged one way everywhere.
 * The text the operator sees is that helper's `codexLoginNextStepLines` too.
 *
 * This module only adds the two places where auth.json is not the whole story,
 * and where the gate must not refuse (`unknown`, fail-open):
 *   - config.toml keeps credentials in the OS keyring
 *     (`cli_auth_credentials_store = "keyring" | "auto"`): logged in, no auth.json;
 *   - OPENAI_API_KEY / CODEX_API_KEY in the launcher's environment.
 *
 * 🔴 Never returns or prints a token. Never copies anything.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexLoginFactsOfHome, codexLoginNextStepLines } from "./codex-node-login";

export type CodexHomeLoginState = "logged-in" | "needs-login" | "unknown";

export interface CodexHomeLoginVerdict {
  readonly state: CodexHomeLoginState;
  /** One phrase for the operator: why this state. No secrets. */
  readonly reason: string;
}

function nonEmpty(v: unknown): v is string { return typeof v === "string" && v.trim().length > 0; }

/** The node's verdict. auth.json is judged by the #529 helper; see the header for the two fail-open cases. */
export function codexHomeLoginState(codexHome: string, env: Record<string, string | undefined> = process.env): CodexHomeLoginVerdict {
  const facts = codexLoginFactsOfHome(codexHome);
  if (facts.loggedIn) return { state: "logged-in", reason: `auth.json has a ${facts.kind === "api-key" ? "API key" : "ChatGPT login"}` };
  let configToml: string | null = null;
  try { configToml = readFileSync(join(codexHome, "config.toml"), "utf-8"); } catch { configToml = null; }
  const store = configToml?.match(/^\s*cli_auth_credentials_store\s*=\s*["']?([A-Za-z]+)["']?/m)?.[1]?.toLowerCase();
  if (store === "keyring" || store === "auto") {
    return { state: "unknown", reason: `config.toml keeps credentials in the OS keyring (cli_auth_credentials_store = "${store}"); not checked` };
  }
  const why = facts.kind === "unreadable" ? "auth.json is not readable JSON"
    : (() => { try { statSync(join(codexHome, "auth.json")); return "auth.json has no ChatGPT token and no API key"; } catch { return "auth.json does not exist"; } })();
  const envKey = ["OPENAI_API_KEY", "CODEX_API_KEY"].find((k) => nonEmpty(env[k]));
  if (envKey) return { state: "unknown", reason: `${why}, but ${envKey} is set in the environment; not checked` };
  return { state: "needs-login", reason: why };
}

/** Exit code for `needs-login`: distinct from 1 (failed) so scripts can tell "do something" from "broken". */
export const NEEDS_LOGIN_EXIT_CODE = 3;

/** What the launcher prints instead of "✅ 就绪": a state line, then the #529 next step. Nothing executed. */
export function describeCodexNeedsLogin(i: { alias: string; codexHome: string; reason: string }): string[] {
  let homeExists = false;
  try { homeExists = statSync(i.codexHome).isDirectory(); } catch { homeExists = false; }
  const alias = /^[A-Za-z0-9_./:@%+=-]+$/.test(i.alias) ? i.alias : `'${i.alias.replace(/'/g, `'\\''`)}'`;
  return [
    `[anet] ⏸ 共存节点 ${i.alias}: needs-login — this node's codex is not logged in (${i.reason}).`,
    `[anet]   CODEX_HOME: ${i.codexHome}`,
    `[anet]   Nothing was started: without a login the TUI parks on Codex's sign-in page and the bridge times out.`,
    ...codexLoginNextStepLines({ alias: i.alias, codexHome: i.codexHome, homeExists, then: `anet node start ${alias}` }),
  ];
}
