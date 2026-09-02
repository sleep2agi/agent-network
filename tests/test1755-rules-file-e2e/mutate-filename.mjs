// 变异：让节点把规则文件写到 workDir/pwned.md 而不是 CLAUDE.md。
// 套件必须因此变红（witnessed-red）；变异只改一处,改不到就退出 1。
import { readFileSync, writeFileSync } from 'node:fs';
const p = process.argv[2];
const src = readFileSync(p, 'utf8');
const needle = 'return runtime === "claude" ? "CLAUDE.md" : "AGENTS.md";';
if (!src.includes(needle)) { console.error('mutate-filename: needle not found in ' + p); process.exit(1); }
writeFileSync(p, src.replace(needle, 'return "pwned.md" as any;'));
console.log('mutate-filename: applied');
