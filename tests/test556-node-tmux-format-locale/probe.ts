// Board #556 — call the real agent-node probes (execTmux → -S $ANET_TMUX_SOCKET).
// argv: <session name> <expected session id | "none"> <expected tui reason>
import { probeTmuxTui } from "../../agent-node/src/runtime/codex-health";
import { tmuxSessionId } from "../../agent-node/src/runtime/codex-appserver-relaunch";

const [name, wantId, wantReason] = process.argv.slice(2);
const tui = probeTmuxTui(name!);
const id = tmuxSessionId(name!);
console.log(`  probe: probeTmuxTui(${name}) = ${JSON.stringify(tui)}; tmuxSessionId = ${id}`);
let ok = tui.reason === wantReason;
ok &&= id === (wantId === "none" ? null : wantId);
process.exit(ok ? 0 : 1);
