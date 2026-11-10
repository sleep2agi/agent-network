import { expect, test as plainTest } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

// #2995 的回归钉：late-child 必须**原子发布** child-pid（写 tmp 再 rename）。
//
// 起因：2026-10-25 CI 在同一套件上红过一次 —— 父进程只等 existsSync(child-pid)，
// 而 writeFileSync 会先建空文件再写内容，于是可能读到 ""；Number("") = 0 →
// processStamp(0) 抛 adopt_pid_invalid。修法是把 PID 原子发布（tmp → rename），
// 屏障改成等"真有一个 >1 的整数"。
//
// 这条是**静态钉**（不依赖容器、不依赖时序）：谁把它改回直接 writeFileSync，
// 这里立刻红，而不是等下一次随机红。
plainTest("late-child publishes the child PID atomically (rename, not a bare write)", () => {
  const src = readFileSync(join(import.meta.dir, "late-child.ts"), "utf8");
  // 必须：先写 tmp，再 rename 到正式名
  expect(src).toMatch(/writeFileSync\(\s*`\$\{dir\}\/child-pid\.tmp`/);
  expect(src).toMatch(/renameSync\(\s*`\$\{dir\}\/child-pid\.tmp`\s*,\s*`\$\{dir\}\/child-pid`/);
  // 不许：直接写正式名（那正是空文件窗口的来源）
  expect(src).not.toMatch(/writeFileSync\(\s*`\$\{dir\}\/child-pid`\s*,/);
});
