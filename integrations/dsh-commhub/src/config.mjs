// Plugin configuration: patch-file config first, environment second.
// The node token is only ever read from the environment or a 0600 file —
// never from the patch file, so it does not end up in a DSH profile on disk.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** JSON-schema-shaped description of the patch-file config (documentation + validation). */
export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    hub: { type: "string", description: "CommHub URL, e.g. http://127.0.0.1:9200 (env ANET_HUB)" },
    alias: { type: "string", description: "This node's alias on the hub (env ANET_ALIAS)" },
    networkId: { type: "string", description: "Network id; optional for single-network tokens (env ANET_NETWORK_ID)" },
    tokenFile: { type: "string", description: "Path to a file holding the ntok_ node token, mode 0600 (env ANET_NODE_TOKEN_FILE). Alternatively set ANET_NODE_TOKEN." },
    ledgerPath: { type: "string", description: "Where to keep the replied-task ledger (env DSH_COMMHUB_LEDGER; default ~/.dsh-commhub/<alias>/ledger.json)" },
    heartbeatMs: { type: "number", description: "report_status interval, default 30000" },
    pollMs: { type: "number", description: "Fallback inbox poll interval, default 60000" },
    turnTimeoutMs: { type: "number", description: "Max time for one agent turn, default 1800000" },
  },
};

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = "ConfigError"; }
}

function readTokenFile(path) {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new ConfigError(`token file ${path} is readable by group/others; chmod 600 it`);
  return readFileSync(path, "utf8").trim();
}

export function resolveConfig(config = {}, env = process.env) {
  for (const key of Object.keys(config ?? {})) {
    if (!(key in configSchema.properties)) {
      if (/token/i.test(key)) throw new ConfigError(`do not put the node token in the DSH patch file ("${key}"); use ANET_NODE_TOKEN or tokenFile`);
      throw new ConfigError(`unknown config key "${key}"`);
    }
  }
  const hub = config.hub ?? env.ANET_HUB;
  const alias = config.alias ?? env.ANET_ALIAS;
  const networkId = config.networkId ?? env.ANET_NETWORK_ID;
  const tokenFile = config.tokenFile ?? env.ANET_NODE_TOKEN_FILE;
  const token = tokenFile ? readTokenFile(tokenFile) : env.ANET_NODE_TOKEN;
  if (!hub) throw new ConfigError("hub is required (config.hub or ANET_HUB)");
  if (!alias) throw new ConfigError("alias is required (config.alias or ANET_ALIAS)");
  if (!token) throw new ConfigError("node token is required (ANET_NODE_TOKEN or tokenFile)");
  if (!/^ntok_/.test(token)) throw new ConfigError("node token must be an ntok_ token minted for this node");
  const ledgerPath = config.ledgerPath ?? env.DSH_COMMHUB_LEDGER ?? join(homedir(), ".dsh-commhub", alias, "ledger.json");
  const num = (v, d) => (typeof v === "number" && v > 0 ? v : d);
  return {
    hub, alias, networkId, token, ledgerPath,
    heartbeatMs: num(config.heartbeatMs, 30_000),
    pollMs: num(config.pollMs, 60_000),
    turnTimeoutMs: num(config.turnTimeoutMs, 30 * 60_000),
  };
}
