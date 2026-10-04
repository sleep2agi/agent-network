// #533 — the non-attach listings, through the real helpers and real tmux.
// argv[2]: session name to look for. Prints PASS/FAIL lines; exit 1 on any FAIL.
import { execTmux } from "../../agent-network/src/tmux";
import { parseTmuxRows, tmuxListArgs, tmuxUtf8Args } from "../../agent-network/src/tmux-format";
import { PANE_LIST_ARGS, paneTargetFor } from "../../agent-network/src/tmux-exact-target";

const name = process.argv[2]!;
let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? "PASS" : "FAIL"} ${m}`); if (!c) fail++; };

const panes = execTmux(PANE_LIST_ARGS, { encoding: "utf8" });
ok(paneTargetFor(panes, name) === `${name}:0.0`, `PANE_LIST_ARGS → paneTargetFor finds ${name}:0.0 (got ${JSON.stringify(paneTargetFor(panes, name))})`);

const pidRows = parseTmuxRows(execTmux(tmuxListArgs(["list-panes", "-a"], ["#{session_name}", "#{pane_pid}"]), { encoding: "utf8" }), 2);
ok(pidRows.some(([s, pid]) => s === name && /^\d+$/.test(pid)), `session_name+pane_pid rows contain ${name} with a numeric pid`);

const idRows = parseTmuxRows(execTmux(tmuxListArgs(["list-sessions"], ["#{session_name}", "#{session_id}"]), { encoding: "utf8" }), 2);
ok(idRows.some(([s, id]) => s === name && id.startsWith("$")), `session_name+session_id rows contain ${name}`);

const names = execTmux(tmuxUtf8Args(["list-sessions", "-F", "#{session_name}"]), { encoding: "utf8" }).split("\n");
ok(names.includes(name), `single-field list-sessions contains ${name}`);

process.exit(fail ? 1 : 0);
