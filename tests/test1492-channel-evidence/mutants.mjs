// Disposable copies only; never mutate the checkout or installed runtime.
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = '/tmp/1492-mutants';
mkdirSync(root, { recursive: true });
for (const dir of ['server', 'agent-network']) {
  mkdirSync(`${root}/${dir}`, { recursive: true });
  cpSync(`/app/${dir}/src`, `${root}/${dir}/src`, { recursive: true });
}
symlinkSync('/app/server/node_modules', `${root}/server/node_modules`);
const variants = [
  ['receipt ignored', 'server/src/task-diagnostic.ts',
   'input.channelNotificationInjectedAt || input.targetEverReportedRuntimeEvidence === false',
   'input.targetEverReportedRuntimeEvidence === false', 'server/src/channel-delivery-evidence.test.ts'],
  ['notification invents turn-start', 'server/src/channel-delivery-evidence.ts',
   'turn_started: observed(task.consumed_at)', 'turn_started: observed(injectedAt)', 'server/src/channel-delivery-evidence.test.ts'],
  ['ACK/event transaction removed', 'server/src/tools.ts',
   'const outcome = db.transaction(() => {', 'const outcome = ((fn: () => any) => fn())(() => {', 'server/src/channel-delivery-http.test.ts'],
  ['old delivery reused after retry', 'server/src/channel-delivery-evidence.ts',
   "        AND NOT EXISTS (SELECT 1 FROM task_events d\n          WHERE d.task_id=e.task_id AND d.event_type='task.send.delivered' AND d.id>e.id)\n",
   '', 'server/src/channel-delivery-http.test.ts'],
];
// Last mutant removes the retry boundary and lets the prior delivery's receipt leak through.
let killed = 0;
for (const [name, file, from, to, test] of variants) {
  const path = `${root}/${file}`, original = readFileSync(path, 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor absent: ${name}`);
  const changed = original.replace(from, to);
  writeFileSync(path, changed);
  const result = spawnSync('bun', ['test', test], { cwd: root, encoding: 'utf8', timeout: 30000 });
  writeFileSync(path, original);
  const output = result.stdout + result.stderr;
  // Compilation/setup crashes are not counted as a killed behavioral mutant.
  const failed = Number(output.match(/\n\s*(\d+) fail\n/)?.[1] ?? 0);
  const passed = Number(output.match(/\n\s*(\d+) pass\n/)?.[1] ?? 0);
  if (result.status !== 0 && failed > 0 && passed > 0 && !output.includes('error: Cannot find module')) {
    killed++; console.log(`KILLED ${name}: pass=${passed} fail=${failed}`);
  } else { console.log(`NOT_KILLED ${name}: rc=${result.status} pass=${passed} fail=${failed}`); process.exitCode = 1; }
}
console.log(`MUTANTS_KILLED=${killed}/${variants.length}`);
rmSync(root, { recursive: true, force: true });
