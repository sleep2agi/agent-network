import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { containerTest as test, fixtureTmux } from "./fixture-tmux.js";
import { execTmux } from "../../agent-node/src/tmux.js";
import { codexTmuxEnv } from "../../agent-node/src/runtime/adopt-codex-tmux.js";

test("fixture cleanup does not claim another creator's pane",()=>{
  const socket=`${mkdtempSync("/tmp/codex-safety-")}/socket`,fixture=fixtureTmux(socket),env=codexTmuxEnv(socket);
  fixture.exec(["new-session","-d","-s","owned","sleep 300"]);
  const foreign=execTmux(["new-session","-d","-P","-F","#{pane_id}","-s","separate-creator","sleep 300"],{env,encoding:"utf8"}).trim();
  try {
    expect(()=>fixture.exec(["kill-pane","-t",foreign])).toThrow("pane not created by fixture");
    fixture.cleanup();
    expect(execTmux(["list-panes","-a","-F","#{pane_id}"],{env,encoding:"utf8"}).trim()).toBe(foreign);
  } finally {
    fixture.cleanup();
    execTmux(["kill-pane","-t",foreign],{env}); // ID from this test's own creation result
  }
});

test("without container opt-in both destructive suites skip before fixture setup",async()=>{
  const child=Bun.spawn(["bun","test","tests/test658-codex-adopt-stop/collect.test.ts","tests/test658-codex-adopt-stop/start-preflight.test.ts"],
    {env:{...process.env,TEST658_CONTAINER:""},stdout:"pipe",stderr:"pipe"});
  const [out,err,rc]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(rc).toBe(0);
  expect(out+err).toMatch(/\b12 skip\b/);
  expect(out+err).toMatch(/\b0 pass\b/);
});
