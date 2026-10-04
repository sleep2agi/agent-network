/**
 * #540 — OpenCode Zen's free tier rejects any request in which a tool is
 * disabled or a permission is denied, answering
 * "OpenCode's free tier can only be used from within OpenCode" (measured on
 * opencode-ai 1.18.1 and 1.18.34 with `{"tools":{"bash":false}}`). Our default
 * safe preset disables every built-in tool, so a free Zen model on a default
 * node fails every task. `anet node create` must say so instead of promising
 * that free models "can still start".
 *
 * The default preset itself is intentionally NOT changed here.
 */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** OpenCode Zen free models are `opencode/<id>-free`. */
export function isOpencodeZenFreeModel(model: string | undefined | null): boolean {
  if (typeof model !== "string") return false;
  return /^opencode\/[^\s/]+-free$/i.test(model.trim());
}

/** Replaces the old "Keyless/free models can still start without a credential." */
export const OPENCODE_KEYLESS_FREE_MODEL_NOTE =
  "No credential is needed for OpenCode Zen free models (opencode/*-free), " +
  "but Zen's free tier rejects every request made under the default safe tool preset; " +
  "a free model needs flags.opencodeUnsafeTools=true, otherwise use a keyed provider.";

/** The exact command that sets flags.opencodeUnsafeTools=true in a node config. */
export function opencodeUnsafeToolsCommand(configFile: string): string {
  const script =
    "const fs=require(\"fs\"),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,\"utf8\"));" +
    "(c.flags??={}).opencodeUnsafeTools=true;fs.writeFileSync(f,JSON.stringify(c,null,2)+\"\\n\")";
  return `node -e ${shellQuote(script)} ${shellQuote(configFile)}`;
}

/**
 * Warning lines for a node whose model is a Zen free model while the safe
 * preset is active. Empty when the combination is not the failing one.
 */
export function opencodeFreeTierSafePresetWarning(opts: {
  nodeId: string;
  model: string | undefined | null;
  unsafeTools: boolean;
  configFile: string;
}): string[] {
  if (opts.unsafeTools || !isOpencodeZenFreeModel(opts.model)) return [];
  const id = shellQuote(opts.nodeId);
  return [
    `[anet] ⚠ ${String(opts.model).trim()} is an OpenCode Zen free model, and this node uses the default safe tool preset.`,
    `[anet]   Zen's free tier rejects any request with a tool disabled ("free tier can only be used from within OpenCode"),`,
    `[anet]   so every task on this node would fail. Pick one:`,
    `[anet]   1) Enable tools (HIGH RISK: trusted tasks only, not a sandbox — use Docker/VM for isolation):`,
    `[anet]        ${opencodeUnsafeToolsCommand(opts.configFile)}`,
    `[anet]      (sets flags.opencodeUnsafeTools=true; restart the node afterwards if it is running)`,
    `[anet]   2) Keep the safe preset and use a keyed provider instead:`,
    `[anet]        anet opencode auth-login ${id} --provider anthropic`,
    `[anet]        anet node edit ${id} --model anthropic/<model>`,
  ];
}
