import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

const zhGettingStarted = read('docs-site/docs/guide/getting-started.md');
const enGettingStarted = read('docs-site/docs/en/guide/getting-started.md');
const zhDashboard = read('docs-site/docs/guide/dashboard.md');
const enDashboard = read('docs-site/docs/en/guide/dashboard.md');
const zhArchitecture = read('docs-site/docs/guide/architecture.md');
const enArchitecture = read('docs-site/docs/en/guide/architecture.md');
const zhReadme = read('README.md');
const enReadme = read('README.en.md');

assert.ok(!zhGettingStarted.includes('进 Chat 页面'));
assert.ok(!enGettingStarted.includes('Go to the Chat page'));
assert.match(zhGettingStarted, /Overview.*在线.*my-bot.*内嵌 ChatPanel/);
assert.match(enGettingStarted, /Overview.*online.*my-bot.*embedded ChatPanel/);

const nav = 'Nodes / Overview / Schedules / SkillHub / Tasks / Servers / Providers / Admin / Settings';
for (const [name, text] of [
  ['zh dashboard', zhDashboard],
  ['en dashboard', enDashboard],
  ['zh architecture', zhArchitecture],
  ['en architecture', enArchitecture],
]) {
  assert.ok(text.includes(nav), `${name} must carry the current primary navigation`);
}

assert.match(zhDashboard, /不存在单独的 Chat 导航页/);
assert.match(enDashboard, /no standalone Chat navigation page/);
assert.ok(!zhArchitecture.includes('Overview / Nodes / Tasks / Messages / Chat / Admin / Settings'));
assert.ok(!enArchitecture.includes('Overview / Nodes / Tasks / Messages / Chat / Admin / Settings'));

assert.ok(!/Chat 面板|Chat 页面/.test(zhReadme));
assert.ok(!/Chat panel|Chat page/i.test(enReadme));

console.log('dashboard ChatPanel documentation path: PASS');
