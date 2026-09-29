// 变异:让节点的日志脱敏器原样放行(redact 返回输入)。套件必须因此变红(witnessed-red);
// 改不到那一处就退出 1,不让变异变成 no-op。
import { readFileSync, writeFileSync } from 'node:fs';
const p = process.argv[2];
const src = readFileSync(p, 'utf8');
const needle = 'let text = base.redactText(line).text;';
if (!src.includes(needle)) { console.error('mutate-redactor: needle not found in ' + p); process.exit(1); }
const out = src.replace(needle, 'return line; let text = base.redactText(line).text;');
if (out === src) { console.error('mutate-redactor: no change'); process.exit(1); }
writeFileSync(p, out);
console.log('mutate-redactor: applied');
