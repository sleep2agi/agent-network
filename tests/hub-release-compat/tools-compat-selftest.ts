// Self-test for compareTools. compare.ts runs it before comparing anything, so a
// comparator that went blind fails the whole run instead of printing green.
//   real pair   — the recorded .74 → .75 tools/list must be additive only
//   controls    — each known-incompatible mutation of the .75 list must be red
import { compareTools, type Tool } from "./tools-compat";

const dir = import.meta.dir + "/fixtures";
const load = (f: string): Tool[] => JSON.parse(require("fs").readFileSync(`${dir}/${f}`, "utf8"));

export function toolsSelftest(): number {
  let fails = 0;
  const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} tools-selftest: ${what}`); if (!ok) fails++; };
  const base = load("tools-0.9.0-preview.74.json"), cand = load("tools-0.9.0-preview.75.json");
  // A fixture that loads as [] would make every comparison trivially green.
  check(base.length > 0 && cand.length > 0, `fixtures non-empty (${base.length} / ${cand.length} tools)`);

  const real = compareTools(base, cand);
  check(real.incompatible.length === 0, `real .74 → .75 pair: 0 incompatible (${real.incompatible.join("; ") || "none"})`);
  check(JSON.stringify(real.added) === JSON.stringify(["requirements_list+[view,changes]"]) && real.newTools.length === 0,
    `real .74 → .75 pair: additive = ${real.added.join(",")}, new tools = [${real.newTools}]`);

  const mutate = (fn: (tools: Tool[]) => void) => { const c = structuredClone(cand); fn(c); return compareTools(base, c); };
  const tool = (c: Tool[], name: string) => c.find((t) => t.name === name)!;
  const controls: [string, (c: Tool[]) => void][] = [
    ["property removed (requirements_list.seq)", (c) => { delete tool(c, "requirements_list").inputSchema!.properties.seq; }],
    // Only `type` changes, so the control cannot pass on some other key's difference.
    ["property retyped (create_node.daemon_node_id: only type → number)", (c) => { const p = tool(c, "create_node").inputSchema!.properties; p.daemon_node_id = { ...p.daemon_node_id, type: "number" }; }],
    ["new REQUIRED param on an existing tool (requirements_list.view)", (c) => { const s = tool(c, "requirements_list").inputSchema!; s.required = [...(s.required ?? []), "view"]; }],
    ["tool removed (tail_node_logs)", (c) => { c.splice(c.findIndex((t) => t.name === "tail_node_logs"), 1); }],
    ["additionalProperties flipped (requirements_list)", (c) => { const s = tool(c, "requirements_list").inputSchema!; s.additionalProperties = !s.additionalProperties; }],
  ];
  for (const [what, fn] of controls) {
    const r = mutate(fn);
    check(r.incompatible.length > 0, `control red: ${what} → ${r.incompatible[0] ?? "NOT DETECTED"}`);
  }
  return fails;
}

if (import.meta.main) process.exit(toolsSelftest() ? 1 : 0);
