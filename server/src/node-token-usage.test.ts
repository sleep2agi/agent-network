// #3952 —— 节点 Token 审计：记账能累加、读账按节点聚合、且**只收计数不收内容**。
//
// admin 原话：「要对节点进行 Token 审计了，能看到节点消耗了多少 Token」。
// 现状是 Hub 里一行都没有（api_tokens 是鉴权令牌 id，不是用量），
// 而节点侧其实看得到（claude/codex 每轮都有 input/output tokens，只是打进了日志）。
//
// 判据四格：
//   ① 累加：同一小时同一 model 报两次 ⇒ 相加（一轮一报是常态，不是覆盖）
//   ② 读账：按节点聚合、按 total 降序（审计第一眼看"谁最多"）
//   ③ 口径：hour 是 UTC 小时桶；sinceHours 用它比较，与写入同口径
//   ④ 形状：表里**没有**任何内容列（prompt / message / credential）—— 由列清单钉住
import { describe, expect, test } from 'bun:test';
import './require-explicit-test-db';
import { db } from './db';
import {
  currentHourUtc,
  normalizeUsage,
  readTokenUsage,
  reportTokenUsage,
  NODE_TOKEN_USAGE_COLUMNS,
} from './node-token-usage';

const net = 'net_tok_usage';
const nodeA = 'n_tok_a';
const nodeB = 'n_tok_b';

function cleanup() {
  db.run('DELETE FROM node_token_usage WHERE network_id = ?1', [net]);
  db.run('DELETE FROM nodes WHERE network_id = ?1', [net]);
}

describe("#3952 节点 Token 审计", () => {
  test("① 同一小时同一 model 报两次 ⇒ 累加", () => {
    cleanup();
    const hour = '2026-11-05T10';
    expect(reportTokenUsage({ networkId: net, nodeId: nodeA, hour, model: 'deepseek/flash', inputTokens: 100, outputTokens: 20 }).ok).toBe(true);
    expect(reportTokenUsage({ networkId: net, nodeId: nodeA, hour, model: 'deepseek/flash', inputTokens: 50, outputTokens: 10 }).ok).toBe(true);
    const row = db.get<any>('SELECT input_tokens, output_tokens FROM node_token_usage WHERE network_id=?1 AND node_id=?2 AND hour=?3', net, nodeA, hour);
    expect(row.input_tokens).toBe(150);
    expect(row.output_tokens).toBe(30);
  });

  test("② 读账按节点聚合、按 total 降序", () => {
    cleanup();
    const hour = currentHourUtc();
    db.run('INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?2,?2,?3)', [nodeA, 'aliasA', net]);
    db.run('INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?2,?2,?3)', [nodeB, 'aliasB', net]);
    reportTokenUsage({ networkId: net, nodeId: nodeA, hour, model: 'm', inputTokens: 10, outputTokens: 5 });
    reportTokenUsage({ networkId: net, nodeId: nodeB, hour, model: 'm', inputTokens: 900, outputTokens: 100 });
    const rows = readTokenUsage(net, 24);
    expect(rows.map((r) => r.node_id)).toEqual([nodeB, nodeA]);
    expect(rows[0].total_tokens).toBe(1000);
    expect(rows[0].alias).toBe('aliasB');
  });

  test("③ 口径：窗口外的行不出现（hour 是 UTC 小时桶）", () => {
    cleanup();
    const now = currentHourUtc();
    const old = currentHourUtc(Date.now() - 48 * 3600_000);
    reportTokenUsage({ networkId: net, nodeId: nodeA, hour: now, model: 'm', inputTokens: 1, outputTokens: 1 });
    reportTokenUsage({ networkId: net, nodeId: nodeA, hour: old, model: 'm', inputTokens: 999, outputTokens: 999 });
    const rows = readTokenUsage(net, 24);
    expect(rows.length).toBe(1);
    expect(rows[0].total_tokens).toBe(2);
  });

  test("cache 单列：报进去不进 total（它是 input 的几百倍，混算会把排行变成「谁最老」）", () => {
    cleanup();
    const hour = currentHourUtc();
    reportTokenUsage({ networkId: net, nodeId: nodeA, hour, model: 'm', inputTokens: 100, outputTokens: 10, cacheReadTokens: 50_000 });
    const rows = readTokenUsage(net, 24);
    expect(rows[0].total_tokens).toBe(110);
    expect(rows[0].cache_read_tokens).toBe(50_000);
  });

  test("④ 形状：表里没有任何内容列（prompt / message / credential 一律不存在）", () => {
    const shape = [...NODE_TOKEN_USAGE_COLUMNS].join(",");
    expect(shape).not.toMatch(/prompt|message|content|credential|secret|token_value/i);
    const cols = db.all<{ name: string }>("PRAGMA table_info(node_token_usage)").map((c) => c.name);
    expect(cols.sort()).toEqual([...NODE_TOKEN_USAGE_COLUMNS].sort());
  });

  test("什么都不报 ⇒ 拒绝，且不写全 0 行（0 与「没上报」不能同形）", () => {
    cleanup();
    expect(reportTokenUsage({ networkId: net, nodeId: nodeA }).ok).toBe(false);
    const n = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM node_token_usage WHERE network_id=?1', net)?.c;
    expect(n).toBe(0);
  });

  test("hour 形状不对 ⇒ 拒绝（不做「猜一个」）", () => {
    expect(normalizeUsage({ networkId: net, nodeId: nodeA, hour: '2026-11-05 10:00:00', inputTokens: 1 })).toBeNull();
  });

  test("镜像：turns / cost 没给就留空（不填 0 冒充「知道」）", () => {
    const norm = normalizeUsage({ networkId: net, nodeId: nodeA, hour: '2026-11-05T10', inputTokens: 5 });
    expect(norm?.turns).toBeNull();
    expect(norm?.costUsd).toBeNull();
  });
});

// #3950 —— 覆盖率分母：让「只有一行」不被读成「只有一个节点在干活」。
import { reportsTokenUsage, tokenUsageCoverage } from "./node-token-usage";

describe("#3950 覆盖率分母", () => {
  test("版本判定：>= .180 会报；旧版本不会；解析不出返回 null（不猜）", () => {
    expect(reportsTokenUsage("2.5.0-preview.181")).toBe(true);
    expect(reportsTokenUsage("2.5.0-preview.180")).toBe(true);
    expect(reportsTokenUsage("2.5.0-preview.164")).toBe(false);
    expect(reportsTokenUsage("2.4.1-preview.9")).toBeNull();
    expect(reportsTokenUsage("")).toBeNull();
    expect(reportsTokenUsage(null)).toBeNull();
  });

  test("分母三数：reporting / capable / 未知版本各自独立", () => {
    const rows = [
      { version: "2.5.0-preview.181" }, { version: "2.5.0-preview.164" },
      { version: "2.5.0-preview.146" }, { version: "codex-app-server" },
      { version: null },
    ];
    const cov = tokenUsageCoverage("net_x", 1, () => rows);
    expect(cov.reporting_nodes).toBe(1);
    expect(cov.capable_nodes).toBe(1);
    expect(cov.sessions_with_version).toBe(3);
    expect(cov.sessions_without_known_version).toBe(2);
    // 镜像：capable 只统计「能解析且 >= 阈值」，不等于 sessions_with_version
    expect(cov.capable_nodes).toBeLessThan(cov.sessions_with_version);
  });
});
