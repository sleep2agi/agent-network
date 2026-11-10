// #669 —— 父任务推断收窄的判据：**候选唯一 + 在窗口内**，且每一种拒绝都要能被数出来。
//
// 为什么这三件事要一起测：
//   收窄是「减少推断」，而减少在派发日志里不留痕（任务照常派出，只是没有父）。
//   没有 rejected 计数时，「收窄生效」与「收窄没写对」同形——两者的 7 天失败率都会降。
//
// 为什么「年龄未知」要算拒绝而不是放行：
//   这条约束的全部价值是「刚派不久」，而 age 未知时无法证明它成立。
//   放行会让这一条在最需要它的输入上失效。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  INFER_WINDOW_MS,
  __resetParentInferForTest,
  decideParentInference,
  noteInferAccepted,
  noteInferRejected,
  parentInferCounters,
} from "./parent-infer.js";

const NOW = 1_800_000_000_000;

beforeEach(() => __resetParentInferForTest());

test("唯一候选且在窗口内 ⇒ 推断到它", () => {
  const r = decideParentInference([{ task_id: "t1", created_at_ms: NOW - 60_000 }], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.task_id, "t1");
});

test("多个候选 ⇒ 不推断（挑最近一条正是挂错的来源）", () => {
  const r = decideParentInference([
    { task_id: "new", created_at_ms: NOW - 10_000 },
    { task_id: "old", created_at_ms: NOW - 500_000 },
  ], NOW);
  assert.equal(r.ok, false);
  // 关键：**不是**退化成「取最新那条」
  assert.equal(!r.ok && r.rejection.reason, "ambiguous_candidates");
  assert.equal(!r.ok && r.rejection.candidates, 2);
});

test("唯一候选但太旧 ⇒ 不推断（那是排在后面还没轮到的）", () => {
  const r = decideParentInference(
    [{ task_id: "t1", created_at_ms: NOW - INFER_WINDOW_MS - 1 }], NOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.rejection.reason, "candidate_too_old");
});

test("窗口边界：正好等于窗口 ⇒ 仍然推断（<= 而非 <）", () => {
  const r = decideParentInference(
    [{ task_id: "t1", created_at_ms: NOW - INFER_WINDOW_MS }], NOW);
  assert.equal(r.ok, true);
});

test("年龄未知 ⇒ 不推断（无法证明「刚派不久」，而那是这条约束的全部价值）", () => {
  const r = decideParentInference([{ task_id: "t1", created_at_ms: null }], NOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.rejection.reason, "candidate_too_old");
  assert.equal(!r.ok && r.rejection.age_ms, null);
});

test("没有候选 ⇒ 也是 ok:false，但 candidates=0（调用方据此决定不计数）", () => {
  const r = decideParentInference([], NOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.rejection.candidates, 0);
  // 「没有要接的任务」是常态，不是拒绝；把它记成拒绝会让分母虚高。
});

test("计数：accepted 与两种 rejected 分开，且窗口值随快照给出", () => {
  noteInferAccepted();
  noteInferRejected({ reason: "ambiguous_candidates", candidates: 2, age_ms: 1000 });
  noteInferRejected({ reason: "candidate_too_old", candidates: 1, age_ms: 999999 });
  noteInferRejected({ reason: "candidate_too_old", candidates: 1, age_ms: 999999 });
  const c = parentInferCounters();
  assert.equal(c.accepted, 1);
  assert.equal(c.rejected_ambiguous, 1);
  assert.equal(c.rejected_too_old, 2);
  assert.equal(c.window_ms, INFER_WINDOW_MS);
  assert.deepEqual(Object.keys(c).sort(), [
    "accepted", "rejected_ambiguous", "rejected_too_old", "since", "window_ms",
  ]);
});
