// Baseline (previous release) vs candidate, step by step:
//   same status + candidate shape ⊇ baseline shape   → ok (additions listed)
//   baseline had no such endpoint (4xx / non-JSON)     → "new endpoint"
//   anything else (status change, removed/retyped key) → UNEXPECTED
//   mcp.tools_list is compared per tool name instead (tools-compat.ts)
import { compareTools } from "./tools-compat";
import { toolsSelftest } from "./tools-compat-selftest";
const a = require("/tmp/baseline.json"), b = require("/tmp/candidate.json");
let unexpected = 0, failures = toolsSelftest();
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures++; };

// Returns [missingOrRetyped, added] paths of y relative to x.
function superset(x: any, y: any, path = ""): [string[], string[]] {
  if (JSON.stringify(x) === JSON.stringify(y)) return [[], []];
  if (x && typeof x === "object" && !Array.isArray(x) && y && typeof y === "object" && !Array.isArray(y)) {
    const miss: string[] = [], add: string[] = [];
    for (const k of Object.keys(x)) {
      if (!(k in y)) { miss.push(`${path}${k}`); continue; }
      const [m, d] = superset(x[k], y[k], `${path}${k}.`); miss.push(...m); add.push(...d);
    }
    for (const k of Object.keys(y)) if (!(k in x)) add.push(`${path}${k}`);
    return [miss, add];
  }
  if (Array.isArray(x) && Array.isArray(y) && x.length === 1 && y.length === 1) return superset(x[0], y[0], `${path}[].`);
  if (Array.isArray(x) && x[0] === "<empty>") return [[], []]; // baseline list was empty: nothing to compare against
  return [[`${path || "<root>"} (${JSON.stringify(x)} → ${JSON.stringify(y)})`], []];
}

// #2176: scheduled-task reply is unread for its creator on the candidate, not on the baseline.
// Baseline before #2176 (.73) must not count it; from .74 on both count it.
const schedBaselineExpect = process.env.SCHED_BASELINE ?? "not-counted";
check(a["sched.unread_for_creator"]?.shape === schedBaselineExpect, `baseline: scheduled reply in creator's unread_by_agent is ${schedBaselineExpect} (${a["sched.unread_for_creator"]?.status})`);
check(b["sched.unread_for_creator"]?.shape === "counted", `candidate: scheduled reply counted in creator's unread_by_agent (${b["sched.unread_for_creator"]?.status})`);
delete a["sched.unread_for_creator"]; delete b["sched.unread_for_creator"];
// .75 (#2180): the new params only change responses for callers that send them.
if (process.env.CHECK_75 === "1") {
  const sum = b["newparam.list_summary"]?.shape?.requirements?.[0] ?? {};
  check(b["newparam.list_summary"]?.status === 200 && "has_description" in sum && "checklist_count" in sum && !("description" in sum) && !("checklist" in sum),
    `view=summary: has_description + checklist_count, no description/checklist (keys: ${Object.keys(sum).length})`);
  const ch = b["newparam.list_changes"]?.shape ?? {};
  check(b["newparam.list_changes"]?.status === 200 && "deleted" in ch && "server_time" in ch && "tombstones_since" in ch, `changes=1: deleted, server_time, tombstones_since present`);
  check(b["newparam.stats_routes"]?.status === 200, `/api/stats/routes (admin): ${b["newparam.stats_routes"]?.status}`);
  const base = a["newparam.list_summary"]?.shape?.requirements?.[0] ?? {};
  check("description" in base, `baseline ignores view=summary (still returns description) — shows the param is new`);
}
// 废弃状态(abandoned):设置要带声明;没声明的读拿到 done;关闭态不逾期;每个被测 app tag 把旧读到的那行归进 done,
// 而把真值 abandoned 归进 pool(这就是投影存在的理由 —— 后一条若哪天变成 done,说明那个版本已认识 abandoned)。
if (process.env.CHECK_ABANDONED === "1") {
  const v = b["newparam.abandoned_values"]?.shape ?? {};
  check(b["newparam.abandoned_set"]?.status === 200 && v.set === "abandoned", `candidate: PATCH column=abandoned with the declaration → ${b["newparam.abandoned_set"]?.status} ${v.set}`);
  check(v.legacy_get === "done" && v.legacy_row?.column === "done", `candidate: undeclared reads see done (get ${v.legacy_get}, list ${v.legacy_row?.column})`);
  check(v.aware_get === "abandoned", `candidate: declared read sees abandoned (${v.aware_get})`);
  check(v.overdue_has_it === false, `candidate: abandoned card with a past due is not in overdue=1`);
  check(a["newparam.abandoned_set"]?.status === 400, `baseline rejects abandoned (${a["newparam.abandoned_set"]?.status}) — shows the value is new`);
  for (const tag of (process.env.APP_TAGS ?? "").split(",").filter(Boolean)) {
    const m = require(`/apps/${tag}/src/requirements-hub.ts`);
    const legacy = m.requirementFromHub(v.legacy_row)?.column;
    const raw = m.requirementFromHub(v.aware_row)?.column;
    check(legacy === "done", `app ${tag} files the projected card under done (${legacy})`);
    console.log(`INFO app ${tag} would file the unprojected value abandoned under: ${raw}`);
  }
}
{
  const x = a["mcp.tools_list"], y = b["mcp.tools_list"];
  const bt = x?.tools ?? [], ct = y?.tools ?? [];
  if (x?.status !== y?.status || !bt.length || !ct.length) { unexpected++; console.log(`UNEXPECTED mcp.tools_list: status ${x?.status} → ${y?.status}, tools ${bt.length} → ${ct.length}`); }
  else {
    const d = compareTools(bt, ct);
    if (d.incompatible.length) { unexpected++; console.log(`UNEXPECTED mcp.tools_list: ${d.incompatible.join("; ")}`); }
    else console.log(`ADDITIVE mcp.tools_list: ${bt.length} → ${ct.length} tools, new tools [${d.newTools}], new params [${d.added.join(", ")}]`);
  }
  delete a["mcp.tools_list"]; delete b["mcp.tools_list"];
}
for (const k of Object.keys(a)) if (k.startsWith("newparam.")) delete a[k];
for (const k of Object.keys(b)) if (k.startsWith("newparam.")) delete b[k];
const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
for (const k of keys) {
  const x = a[k], y = b[k];
  if (JSON.stringify(x) === JSON.stringify(y)) continue;
  if (!x) { console.log(`NEW-STEP ${k}`); continue; }
  if (!y) { unexpected++; console.log(`UNEXPECTED ${k}: step missing on candidate`); continue; }
  const baselineHad = x.status >= 200 && x.status < 300 && x.shape !== "string";
  if (!baselineHad) { console.log(`NEW-ENDPOINT ${k}: baseline ${x.status}${x.shape === "string" ? " non-JSON" : ""} → candidate ${y.status}`); continue; }
  if (x.status !== y.status) { unexpected++; console.log(`UNEXPECTED ${k}: status ${x.status} → ${y.status}`); continue; }
  const [miss, add] = superset(x.shape, y.shape);
  if (miss.length) { unexpected++; console.log(`UNEXPECTED ${k}: removed/retyped ${miss.join(", ")}`); }
  else console.log(`ADDITIVE ${k}: + ${add.join(", ")}`);
}

// member_presence: whatever the candidate pushes, every tested app build must ignore it.
const events = JSON.parse(require("fs").readFileSync("/tmp/candidate-presence.json", "utf8"));
for (const tag of (process.env.APP_TAGS ?? "desktop-v0.2.162,desktop-v0.2.163,desktop-v0.2.164,desktop-v0.2.165,desktop-v0.2.166").split(",")) {
  const m = require(`/apps/${tag}/src/desktop-message-consume.ts`);
  const results = events.map((e: unknown) => m.consumeDesktopMessageEvent(e, { networkId: "any" }).status);
  check(results.every((s: string) => s === "ignore"), `app ${tag} ignores the candidate's member_presence events (${results.join(",") || "none sent"})`);
}
const fivexx = keys.filter((k) => (b[k]?.status ?? 0) >= 500);
check(fivexx.length === 0, `candidate 5xx: ${fivexx.join(",") || "none"}`);
console.log(`steps=${keys.length} unexpected=${unexpected} check_failures=${failures}`);
process.exit(unexpected || failures ? 1 : 0);
