import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { containerTest as test, fixtureTmux } from "./fixture-tmux.js";
import { listCodexPanes } from "../../agent-node/src/runtime/adopt-codex-tmux.js";

// Inject only a client's diagnostic; socket, server and panes are real and
// private. No global module mocks, host servers, or signals to unowned PIDs.
for (const scenario of ["gone","live","persistent","permission","timeout","malformed","strict"] as const)
test(`listing exit race: ${scenario}`,()=>{
  const root=mkdtempSync("/tmp/codex-listing-"),socket=`${root}/socket`;
  const scope={layout:"native" as const,alias:"listing-fixture",socket,workdir:root,codexHome:root,
    uid:process.getuid!(),marker:"11111111-1111-4111-8111-111111111111"};
  const fixture=fixtureTmux(socket),savedPath=process.env.PATH;
  const pane=String(fixture.exec(["new-session","-d","-s",scope.alias,"sleep 300"])).trim();
  mkdirSync(`${root}/bin`);
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
  writeFileSync(`${root}/bin/tmux`,[
    "#!/bin/sh", "set -eu",
    `count=${quote(root+"/count")}`,
    'n=0; if [ -f "$count" ]; then n=$(cat "$count"); fi',
    'n=$((n+1)); printf "%s" "$n" > "$count"',
    'if [ "$n" -eq 1 ]; then',
    ...(scenario==="gone"?[`  /usr/bin/tmux -S ${quote(socket)} kill-pane -t ${quote(pane)}`]:[]),
    '  echo "server exited unexpectedly" >&2', '  exit 1', 'fi',
    ...(scenario==="persistent"?['echo "server exited unexpectedly" >&2','exit 1']:
      scenario==="permission"?['echo "permission denied" >&2','exit 1']:
      scenario==="timeout"?['echo "timeout" >&2','exit 124']:
      scenario==="malformed"?['echo "invalid row"','exit 0']:['exec /usr/bin/tmux "$@"']),
    "",
  ].join("\n"),{mode:0o700});
  try {
    process.env.PATH=`${root}/bin:${savedPath}`;
    if (scenario==="gone") expect(listCodexPanes(scope,true)).toEqual([]);
    else if (scenario==="live") expect(listCodexPanes(scope,true).map(r=>r[2])).toEqual([pane]);
    else expect(()=>listCodexPanes(scope,scenario!=="strict")).toThrow(
      scenario==="malformed"?"adopt_tmux_listing_invalid":"adopt_tmux_listing_failed");
    const calls=Number(readFileSync(`${root}/count`,"utf8"));
    if (scenario==="gone") {
      // tmux may remove the socket before the recheck, or leave a stale socket
      // that a second real list reports as having no server. Both prove absence.
      expect(calls).toBeGreaterThanOrEqual(1);
      expect(calls).toBeLessThanOrEqual(2);
    } else expect(calls).toBe(scenario==="persistent"?3:scenario==="strict"?1:2);
  } finally {
    if(savedPath===undefined)delete process.env.PATH;else process.env.PATH=savedPath;
    fixture.cleanup();
  }
});
