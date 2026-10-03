// #505 Docker repro — runs ONLY inside the test505 container (run.sh refuses elsewhere).
//
// Setup: a DEFAULT tmux server with one dummy session, and $TMUX/$TMUX_PANE
// pointing at it — exactly what a sub-agent inherits from the pane it runs in.
// Then:
//   control  : raw `TMUX_TMPDIR=/tmp/x tmux …` still talks to the DEFAULT server
//              (this is the incident mechanism; if it ever stops reproducing,
//              the test below proves nothing and we say so).
//   helper   : execTmux with TMUX_TMPDIR=/tmp/x creates/lists sessions on
//              /tmp/x only; ANET_TMUX_SOCKET likewise; kill-server is refused;
//              the dummy default session survives all of it.
//   default  : with neither variable set, the helper still reaches the default
//              server (production behaviour unchanged).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const which = process.argv[2] ?? "agent-network";
// argv[3]: an alternative helper path — run.sh feeds a mutated copy to prove this file can go red.
const mod = await import(process.argv[3] ?? `/workspace/${which}/src/tmux.ts`);
const { execTmux, spawnSyncTmux, TmuxKillServerRefused } = mod;

const uid = process.getuid!();
const DEFAULT_SOCK = `/tmp/tmux-${uid}/default`;
const DUMMY = `dummy-default-${which}`;
let pass = 0, fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log(`  PASS ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); }
};
const sessionsOn = (sock: string): string[] => {
  const r = spawnSync("tmux", ["-S", sock, "list-sessions", "-F", "#S"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean).sort() : [];
};

console.log(`# test505 [${which}] uid=${uid} tmux=${execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim()}`);

// ── default server + dummy session, then capture its $TMUX ─────────────────
const cleanEnv = { PATH: process.env.PATH!, HOME: process.env.HOME! };
execFileSync("tmux", ["new-session", "-d", "-s", DUMMY, "sleep 3600"], { env: cleanEnv });
const tmuxVar = execFileSync("tmux", ["display-message", "-p", "-t", `=${DUMMY}`, "#{socket_path},#{pid}"], { encoding: "utf8", env: cleanEnv }).trim() + ",0";
const pane = execFileSync("tmux", ["list-panes", "-t", `=${DUMMY}`, "-F", "#{pane_id}"], { encoding: "utf8", env: cleanEnv }).trim();
console.log(`  inherited TMUX=${tmuxVar} TMUX_PANE=${pane}`);
ok(tmuxVar.startsWith(`${DEFAULT_SOCK},`), "the parent $TMUX names the default socket");
ok(/^%\d+$/.test(pane), "the parent $TMUX_PANE is a real pane id");
ok(sessionsOn(DEFAULT_SOCK).includes(DUMMY), "dummy session is on the default server");

const inherited = { ...cleanEnv, TMUX: tmuxVar, TMUX_PANE: pane };

// ── control: the incident mechanism, with RAW tmux ─────────────────────────
const rawLs = spawnSync("tmux", ["list-sessions", "-F", "#S"], { encoding: "utf8", env: { ...inherited, TMUX_TMPDIR: "/tmp/x-raw" } });
const rawSees = rawLs.stdout.split("\n").filter(Boolean);
console.log(`  control: raw 'TMUX_TMPDIR=/tmp/x-raw tmux list-sessions' → ${JSON.stringify(rawSees)}`);
ok(rawSees.includes(DUMMY), "control reproduces: raw tmux ignores TMUX_TMPDIR while $TMUX is set (it lands on the DEFAULT server)");

// ── helper, TMUX_TMPDIR ────────────────────────────────────────────────────
const isoDir = `/tmp/x-${which}`;
const isoSock = `${isoDir}/tmux-${uid}/default`;
const isoEnv = { ...inherited, TMUX_TMPDIR: isoDir };
execTmux(["new-session", "-d", "-s", "iso-probe", "sleep 3600"], { env: isoEnv, stdio: "pipe" });
const isoLs = execTmux(["list-sessions", "-F", "#S"], { env: isoEnv, encoding: "utf8" }).split("\n").filter(Boolean);
console.log(`  helper TMUX_TMPDIR=${isoDir}: list-sessions → ${JSON.stringify(isoLs)}`);
ok(JSON.stringify(isoLs) === JSON.stringify(["iso-probe"]), "helper lists only the isolated server's session");
ok(existsSync(isoSock), `socket created at ${isoSock}`);
ok(JSON.stringify(sessionsOn(isoSock)) === JSON.stringify(["iso-probe"]), "isolated socket holds iso-probe only");
ok(!sessionsOn(DEFAULT_SOCK).includes("iso-probe"), "iso-probe did NOT land on the default server");

let refused = false;
try { execTmux(["kill-server"], { env: isoEnv, stdio: "pipe" }); } catch (e) { refused = e instanceof TmuxKillServerRefused; }
ok(refused, "execTmux kill-server throws TmuxKillServerRefused");
let refusedSync = false;
try { spawnSyncTmux(["kill-session", "-t", "=x", ";", "kill-server"], { env: isoEnv }); } catch (e) { refusedSync = e instanceof TmuxKillServerRefused; }
ok(refusedSync, "chained `… ; kill-server` refused too");

// tear the isolated server down the allowed way: kill its only session
execTmux(["kill-session", "-t", "=iso-probe"], { env: isoEnv, stdio: "pipe" });
ok(sessionsOn(DEFAULT_SOCK).includes(DUMMY), "dummy default session survived the TMUX_TMPDIR run");

// ── helper, ANET_TMUX_SOCKET ───────────────────────────────────────────────
const explicitSock = `/tmp/anet-explicit-${which}.sock`;
const exEnv = { ...inherited, ANET_TMUX_SOCKET: explicitSock };
execTmux(["new-session", "-d", "-s", "explicit-probe", "sleep 3600"], { env: exEnv, stdio: "pipe" });
const exLs = execTmux(["list-sessions", "-F", "#S"], { env: exEnv, encoding: "utf8" }).split("\n").filter(Boolean);
console.log(`  helper ANET_TMUX_SOCKET=${explicitSock}: list-sessions → ${JSON.stringify(exLs)}`);
ok(JSON.stringify(exLs) === JSON.stringify(["explicit-probe"]), "ANET_TMUX_SOCKET: only the explicit server's session");
ok(!sessionsOn(DEFAULT_SOCK).includes("explicit-probe"), "explicit-probe did NOT land on the default server");
execTmux(["kill-session", "-t", "=explicit-probe"], { env: exEnv, stdio: "pipe" });

// ── helper, no isolation vars: unchanged default behaviour ─────────────────
const defLs = execTmux(["list-sessions", "-F", "#S"], { env: inherited, encoding: "utf8" }).split("\n").filter(Boolean);
console.log(`  helper (no isolation vars): list-sessions → ${JSON.stringify(defLs)}`);
ok(defLs.includes(DUMMY), "without isolation vars the helper still reaches the default server");

// ── final ──────────────────────────────────────────────────────────────────
const finalDefault = sessionsOn(DEFAULT_SOCK);
console.log(`  default server at end: ${JSON.stringify(finalDefault)}`);
ok(finalDefault.includes(DUMMY), "dummy default session is still alive at the end");
execFileSync("tmux", ["kill-session", "-t", `=${DUMMY}`], { env: cleanEnv });

console.log(`# test505 [${which}] Results: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);
