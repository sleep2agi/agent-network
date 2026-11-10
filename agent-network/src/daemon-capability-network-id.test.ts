// #cap — `anet daemon list` 的「创建能力」一列曾经长期印
// 「hub 返回 HTTP 400」，因为取 /api/host-supervisors 时没带 network_id。
// 这条契约钉住：请求必须带上 network_id，且缺登录态时要先去 /api/networks 取。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let p = 0, t = 0;
const ck = (n: string, c: boolean) => { t++; if (c) { p++; console.log('  ✓', n); } else console.log('  ✗', n); };

const cli = readFileSync(join(import.meta.dir, '..', 'bin', 'cli.ts'), 'utf8');
const fn = cli.slice(cli.indexOf('async function fetchDaemonCapabilities'));

ck('daemon capability fetch carries network_id',
  /\/api\/host-supervisors\$\{netQ\}/.test(fn) && /network_id=\$\{encodeURIComponent\(netId\)\}/.test(fn));
ck('falls back to login state first, /api/networks second',
  /gc as any\)\.network_id/.test(fn) && /\/api\/networks/.test(fn));
ck('no bare host-supervisors request left in that function',
  !/fetch\(`\$\{hub\}\/api\/host-supervisors`,/.test(fn));

console.log(`\n${p}/${t} passed`);
if (p !== t) process.exit(1);
