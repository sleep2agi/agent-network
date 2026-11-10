#!/usr/bin/env node
// RFC-029 release pairing, published side.
//
// `opencode-agent-node-pair.test.ts` keeps the two constants in lockstep in the
// tree, but a release can still hand out a HALF pair: agent-node@X is on npm and
// agent-network@Y (the CLI that declares PAIRED_AGENT_NODE_VERSION=X) is only
// staged, so `npm i -g agent-node@X` lands next to a CLI that refuses it.
// 2026-10-19: node .150 went out, CLI .186 sat in npm's staging queue, and the
// only installable pair was the older .184/.148.
//
// This script reads the pair from the tree and asks the registry. Exit 1 when
// either half is missing, so the release job fails loudly instead of shipping
// something users cannot pair.
//
//   node scripts/check-pair-published.mjs            # uses the tree + npm
//   node scripts/check-pair-published.mjs --json     # machine readable
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function readPair(text) {
  const net = /PAIRED_AGENT_NETWORK_VERSION\s*=\s*"([^"]+)"/.exec(text)?.[1];
  const node = /PAIRED_AGENT_NODE_VERSION\s*=\s*"([^"]+)"/.exec(text)?.[1];
  return net && node ? { network: net, node } : null;
}

/** 从 CI 的 TARBALL 路径认出「本次发的是哪个包」；认不出就返回 null（不猜）。 */
function mineFromTarball(tarball) {
  if (!tarball) return null;
  const m = /sleep2agi-(agent-node|agent-network)-/.exec(String(tarball));
  return m ? m[1] : null;
}

function publishedVersion(pkg) {
  try {
    return execFileSync('npm', ['view', `${pkg}`, 'version'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

export function checkPair({ network, node }, lookup) {
  const networkVersion = lookup('@sleep2agi/agent-network@' + network);
  const nodeVersion = lookup('@sleep2agi/agent-node@' + node);
  const problems = [];
  if (networkVersion !== network) problems.push(`agent-network@${network} is not published (got ${networkVersion ?? 'missing'})`);
  if (nodeVersion !== node) problems.push(`agent-node@${node} is not published (got ${nodeVersion ?? 'missing'})`);
  return { ok: problems.length === 0, pair: { network, node }, problems };
}

// 2026-10-31 —— 元门要求每个已接线的门都能 `--selftest`（否则「绿」与「什么都没查」同形）。
// 这门的判据是纯函数 `checkPair`，所以自检直接喂合成 lookup：三种输入必须各自命中。

/**
 * 把「两半都在 / 顺序问题 / 发布失败」拆开 —— 三者的处置完全不同。
 *
 *   ok       两半都在
 *   ordering 本次发的这半**已在 registry 上**，缺的只是对面那半
 *            （先 node 后 CLI 的发布顺序使然：node 那半收尾时 CLI 还没发）
 *   publish  本次发的这半**自己就缺** ⇒ 真的没发出去
 *
 * 为什么必须拆：2026-10-31 实发 `.171` 时，publish 步骤成功、registry 上查得到，
 * 但这条断言仍然 exit 1 —— 于是**每一次配对发布都会在 jobs 列表里留一个红**。
 * 红得永远合理的地方，就没有红。这与 test-inventory 那 277 次 0 job 是同一个病。
 */
export function classify(problems, mine) {
  if (problems.length === 0) return 'ok';
  if (!mine) return 'publish';                       // 认不出本次发的哪个 ⇒ 不猜，按失败处理
  const missing = problems.map((x) => (x.startsWith('agent-node@') ? 'agent-node' : 'agent-network'));
  return missing.includes(mine) ? 'publish' : 'ordering';
}

function selftest() {
  // 每条都写明「本次发的是哪个包」—— 同一个 problems，mine 不同则处置不同。
  const cases = [
    ["两半都在", { network: '0.9.9', node: '0.2.9' },
      (spec) => spec.includes('agent-network@') ? '0.9.9' : '0.2.9', 'agent-node', true, 0, 'ok'],
    // 发 node，缺 CLI ⇒ 顺序（先 node 后 CLI）
    ["发 node、缺 CLI", { network: '0.9.9', node: '0.2.9' },
      (spec) => spec.includes('agent-network@') ? null : '0.2.9', 'agent-node', false, 1, 'ordering'],
    // 发 CLI，缺 node ⇒ 也是对面那半缺失（处置同样是「去 dispatch 它」）
    ["发 CLI、缺 node", { network: '0.9.9', node: '0.2.9' },
      (spec) => spec.includes('agent-network@') ? '0.9.9' : null, 'agent-network', false, 1, 'ordering'],
    // 🔴 本次发的那个包自己就缺 ⇒ 不是顺序问题，是真没发出去
    ["发 node、而 node 自己没出去", { network: '0.9.9', node: '0.2.9' },
      (spec) => spec.includes('agent-network@') ? '0.9.9' : null, 'agent-node', false, 1, 'publish'],
  ];
  let fails = 0;
  for (const [label, pair, lookup, mine, wantOk, wantProblems, wantKind] of cases) {
    const r = checkPair(pair, lookup);
    const kind = classify(r.problems, mine);
    const ok = r.ok === wantOk && r.problems.length === wantProblems && kind === wantKind;
    if (!ok) { fails += 1; console.error(`✗ selftest ${label}: ok=${r.ok} problems=${r.problems.length} kind=${kind}（期望 ${wantOk}/${wantProblems}/${wantKind}）`); }
    else console.log(`✓ selftest ${label} ⇒ ok=${r.ok} kind=${kind}`);
  }
  // 空对（读不到常量）必须自己说「读不到」，不能当成 ok
  const empty = readPair('export const NOTHING = 1');
  if (empty !== null) { fails += 1; console.error('✗ selftest 读不到常量时应返回 null'); }
  else console.log('✓ selftest 读不到常量 ⇒ null（不是 ok）');
  if (fails) { console.error(`✗ selftest ${fails} 例失败`); return 1; }
  console.log('✓ selftest 4/4 + 空对一例通过');
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && process.argv.includes('--selftest')) {
  process.exit(selftest());
}

if (isMain) {
  const pair = readPair(readFileSync(join(root, 'agent-network/src/opencode-agent-node-pair.ts'), 'utf8'));
  if (!pair) { console.error('check-pair-published: cannot read the pair constants'); process.exit(2); }
  const result = checkPair(pair, (spec) => publishedVersion(spec));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`pair ok: agent-network@${pair.network} + agent-node@${pair.node}`);
  else {
    console.error(`🔴 half pair: agent-network@${pair.network} + agent-node@${pair.node}`);
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error('  do not announce the surviving half; publish the missing one (or pin users to the previous full pair)');
    // 2026-10-31 —— 实测踩了一次：两个 dispatch 只隔 6 秒 ⇒ 两个 job 并行，
    // node 那半收尾时 CLI 还在 registry 传播中 ⇒ 这条报「half pair」，读起来像**发布失败**。
    // 而实际上 publish 步骤是成功的（registry + shasum 都核对过）。
    // ⇒ 把「顺序问题」与「发布失败」分开说：只有当**本次这条 job 发的那个包**已经在 registry 上、
    //    缺的只是对面那半时，才给出这条提示。
    const mine = mineFromTarball(process.env.TARBALL);
    if (mine) {
      // 只认「缺的恰好是**对面那半**」这一种：本次发的那个包没在 problems 里 ⇒ 它没缺。
      const missing = result.problems.map((x) => (x.startsWith('agent-node@') ? 'agent-node' : 'agent-network'));
      const onlyCounterpart = missing.length === 1 && !missing.includes(mine);
      if (onlyCounterpart) {
        console.error(`  ⓘ 本次发布的是 ${mine}，它已在 registry 上；缺的是 ${missing[0]} —— **是顺序**，不是发布失败。`);
        console.error('    下一步：dispatch 对面那半（先 node 后 CLI）；两半的顺序由 release-pair-core 复查。');
      }
    }
  }
  // 🔴 只有 ok 与 ordering 才 exit 0。
  //    ordering 用 ::warning:: 留在 Actions 页上（不吞掉），因为「半边」这个事实仍需要被看见；
  //    但它不再是红 —— 在先 node 后 CLI 的顺序下，这条断言**永远**会在 node 那一轮红。
  const kind = classify(result.problems, mineFromTarball(process.env.TARBALL));
  if (kind === 'ordering') {
    console.log(`::warning::half pair (ordering): agent-network@${pair.network} + agent-node@${pair.node} —— 缺的是对面那半，dispatch 它`);
    process.exit(0);
  }
  process.exit(kind === 'ok' ? 0 : 1);
}
