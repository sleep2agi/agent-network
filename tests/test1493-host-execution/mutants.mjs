// Disposable copies only; never mutate the checkout or installed runtime.
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = '/tmp/1493-mutants';
mkdirSync(root, { recursive: true });
for (const dir of ['server', 'agent-node']) {
  mkdirSync(`${root}/${dir}`, { recursive: true });
  cpSync(`/app/${dir}/src`, `${root}/${dir}/src`, { recursive: true });
}
symlinkSync('/app/server/node_modules', `${root}/server/node_modules`);
const variants = [
 ['specific terminal error overwritten by receipt category','agent-node/src/runtime/host-execution-receipt.ts',
  '{error:args.error ?? failure}','{error:failure}','server/src/host-execution-receipt.test.ts'],
 ['legacy config restart bypass restored','server/src/tools.ts',
  'if (applyMode !== "hot" && legacyRestartUnsupported(db, node)) {',
  'if (false && applyMode !== "hot" && legacyRestartUnsupported(db, node)) {','server/src/host-execution-http.test.ts'],
 ['delivered start claim automatically retried','server/src/tools.ts',
  'if (inFlight.delivered_at !== null) return', 'if (false && inFlight.delivered_at !== null) return','server/src/host-execution-http.test.ts'],
 ['legacy restart gate removed','server/src/tools.ts',
  'if (legacyRestartUnsupported(db,node)) {','if (false && legacyRestartUnsupported(db,node)) {','server/src/host-execution-http.test.ts'],
 ['exited launcher reported started','agent-node/src/runtime/host-execution-receipt.ts',
  "if (status === 'started' && observed.state === 'absent')", "if (false && status === 'started' && observed.state === 'absent')",'server/src/host-execution-receipt.test.ts'],
 ['duplicate command replay removed','agent-node/src/runtime/host-execution-receipt.ts',
  'const cached = replies.get(key);','const cached = undefined;','server/src/host-execution-receipt.test.ts'],
 ['start/stop finalization transaction removed','server/src/tools.ts',
  'db.transaction(() => {\n          saveExecutionReceipt',
  '((fn: () => any) => fn())(() => {\n          saveExecutionReceipt','server/src/host-execution-http.test.ts'],
 ['create finalization transaction removed','server/src/tools.ts',
  'return evidence.receipt ? db.transaction(finalize) : finalize();','return finalize();','server/src/host-execution-http.test.ts'],
];
let killed = 0;
for (const [name, file, from, to, test] of variants) {
  const path = `${root}/${file}`, original = readFileSync(path, 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor absent: ${name}`);
  let changed = original.replaceAll(from, to);
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
