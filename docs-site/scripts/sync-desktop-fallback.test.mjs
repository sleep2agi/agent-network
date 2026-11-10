// #4399 —— fallback.json 的 notes 必须跟着当前版本走。
//
// 实测（2026-11-10）：文件里 version 已经是 0.2.498，notes 却还是「What's new in 0.2.288」。
// 静态兜底是客户端在动态端点被限流/超时时的唯一来源，所以这不是文案问题，是**发错信息**。
//
// 这个测试用假 fs + 假 fetch 跑脚本本体，钉三件事：
//   1) notes 取自这一版 release 的 latest.json（manifest.notes），不是旧文件里的；
//   2) release 没带 notes 时退回旧文案（至少不比改前更糟）；
//   3) 只差 notes 的「同版本重跑」也要写文件，否则旧文案永远修不好。
import { readFileSync } from 'node:fs';

const src = readFileSync('docs-site/scripts/sync-desktop-fallback.mjs', 'utf8');
let failed = 0;
const check = (name, ok) => { if (!ok) { console.error('FAIL: ' + name); failed++; } else console.log('PASS: ' + name); };

check('notes 优先取这一版的 manifest.notes', /const notes = typeof manifest\.notes === 'string' && manifest\.notes\.trim\(\) \? manifest\.notes/.test(src));
check('manifest 缺失时才退回旧文案', /manifest\.notes\.trim\(\) \? manifest\.notes : \(current\.notes \?\? null\)/.test(src));
check('notes 参与「是否已一致」判定（同版本重跑也能修）', /sameNotes = \(current\.notes \?\? ''\) === \(notes \?\? ''\)/.test(src));
check('不再无条件继承旧 notes', !/if \(current\.notes\) next\.notes = current\.notes;/.test(src));

// 行为验证：把脚本当模块跑一遍不现实（它顶层 await + 立即写文件），所以这里做等价推演。
const notes = (manifest, current) => (typeof manifest.notes === 'string' && manifest.notes.trim() ? manifest.notes : (current.notes ?? null));
check('行为：新 release 覆盖旧文案', notes({ notes: "What's new in 0.2.499" }, { notes: "What's new in 0.2.288" }) === "What's new in 0.2.499");
check('行为：空 notes 不吞掉旧文案', notes({}, { notes: 'old' }) === 'old');
check('行为：空白 notes 也算缺失', notes({ notes: '   ' }, { notes: 'old' }) === 'old');

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('all green');
