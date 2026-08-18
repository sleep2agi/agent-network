#!/usr/bin/env node
/* eslint-disable */
// anet 的 bin 入口垫片 —— 唯一职责:在【解析真正的 ESM 入口之前】把 Node 版本讲清楚。
//
// 🔴 为什么必须是 CJS,而且必须是手写不进构建:
//
//   dist/bin/cli.js 是 ESM(package.json 里 type: module),而且经 javascript-obfuscator
//   处理过。老 Node 读到它的第一行 `import{createRequire}from'node:module'` 就抛
//
//       SyntaxError: Unexpected token {
//
//   ——**在任何一行代码执行之前**。cli.ts 里那个 checkNodeVersion()（required "22.13.0"）
//   写在同一个文件里,所以它永远轮不到跑。**一个写在 ESM 里的版本检查,救不了一个
//   连 ESM 都解析不了的 Node。**
//
//   用户实际看到的是一屏混淆后的代码 + SyntaxError,完全指不到真因。
//   （2026-08-18 现场:Node 10/12 世代的栈,`internal/bootstrap/node.js`、
//    `Function.Module.runMain`、`loader.js:723`。）
//
//   package.json 的 engines.node>=22.13.0 也不拦:npm 默认 engine-strict=false,
//   那只是安装时的一句警告。
//
// 🔴 本文件的写法约束(违反其中任何一条,垫片自己就会在同一个地方炸):
//   - 只用 ES5 语法:var / function / 字符串拼接。不用 const/let、箭头函数、
//     模板串、可选链(?.)、空值合并(??)。
//   - **不能出现字面量的 `import(...)`** —— 动态 import 是 Node 12.17+ 才能【解析】的
//     语法,老 Node 在解析阶段就会失败。所以用 new Function 把它推迟到调用时再解析,
//     而调用只发生在版本检查通过之后。
//   - 不进 bun build,不进 obfuscator。构建里只 cp 过去。

var REQUIRED = '22.13.0';

function parts(v) {
  var a = String(v).split('.');
  return [parseInt(a[0], 10) || 0, parseInt(a[1], 10) || 0, parseInt(a[2], 10) || 0];
}

var cur = parts(process.versions.node);
var req = parts(REQUIRED);
var ok = cur[0] > req[0]
  || (cur[0] === req[0] && cur[1] > req[1])
  || (cur[0] === req[0] && cur[1] === req[1] && cur[2] >= req[2]);

if (!ok) {
  console.error('');
  console.error('  ❌ anet 需要 Node >= ' + REQUIRED + '，当前是 Node ' + process.versions.node + '。');
  console.error('');
  console.error('     这不是 anet 的 bug —— 它的入口是 ESM，你这个版本的 Node 连解析都做不到，');
  console.error('     所以你会看到一屏代码加一句 SyntaxError，而真因是版本。');
  console.error('');
  console.error('     升级 Node（任选其一）:');
  console.error('       nvm install 22 && nvm use 22');
  console.error('       curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs');
  console.error('');
  console.error('     然后: node -v && anet -v');
  console.error('');
  process.exit(1);
}

var path = require('path');
var url = require('url');
var entry = path.join(__dirname, 'cli.js');

// 🔴 把 argv[1] 指回真入口。cli.ts 有多处用 process.argv[1] 推自身位置
// （:792 resolve(argv[1])、:1094-1095 join(argv[1],'..','..')、:4445）。
// 不改的话 argv[1] 会变成本垫片的路径 —— 同目录，多数推导仍成立，
// 但"多数成立"不是"成立"，直接指回去让行为逐字不变。
process.argv[1] = entry;

// 见上:不能写字面量 import()。
var dynamicImport = new Function('u', 'return import(u);');
dynamicImport(url.pathToFileURL(entry).href).catch(function (e) {
  console.error('[anet] 无法加载 ' + entry);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
