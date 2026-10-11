/**
 * Unified entry for `bun build --compile`.
 *
 *   anet ...            CLI (bin/cli.ts)
 *   anet __hub ...      embedded commhub-server
 *   anet __node ...     embedded agent-node
 *   anet __print-config-token
 *                       print config.json `token` from $ANET_EXTAPP_CONFIG
 *                       (internal; the Codex external-appserver pane used to
 *                       do this with `node -e`, which the compiled binary is not)
 *
 * Not the npm bin. `package.json` `bin.anet` stays `dist/bin/anet.cjs`.
 */
import { readFileSync } from "node:fs";
import {
  STANDALONE_BUILD_STAMP,
  dispatchStandalone,
  nodeStyleArgv,
  standaloneUserArgs,
} from "../src/standalone-bin.ts";

const userArgs = standaloneUserArgs(process.argv);
const dispatch = dispatchStandalone(userArgs);

if (dispatch.kind === "print-config-token") {
  const path = process.env.ANET_EXTAPP_CONFIG;
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
      if (typeof parsed.token === "string") process.stdout.write(parsed.token);
    } catch {
      /* empty stdout: the shell snippet warns when the token is missing */
    }
  }
  process.exit(0);
}

process.argv = nodeStyleArgv(process.execPath, dispatch.argv);

if (dispatch.kind === "hub") {
  const version = STANDALONE_BUILD_STAMP.versions?.commhubServer;
  if (version) process.env.ANET_EMBEDDED_COMMHUB_VERSION = version;
  await import("../../server/bin/commhub.ts");
} else if (dispatch.kind === "node") {
  const version = STANDALONE_BUILD_STAMP.versions?.agentNode;
  if (version) process.env.ANET_EMBEDDED_AGENT_NODE_VERSION = version;
  await import("../../agent-node/src/cli.ts");
} else {
  await import("./cli.ts");
}
