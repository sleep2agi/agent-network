// MCP tools/list compatibility, keyed by tool name.
//
// The generic step comparator folds an array into one merged element shape, so
// for tools[] every tool's inputSchema lands in a single "|"-joined union and a
// purely additive change to one tool (#2181: requirements_list +view +changes)
// reads as "removed/retyped". Comparing per tool name keeps the distinction
// that matters to an existing caller:
//   incompatible — a tool is gone; a baseline property is gone or its schema
//                  changed (descriptions ignored); `required` differs; any other
//                  top-level inputSchema key (e.g. additionalProperties) differs
//   additive     — new tools; new properties that are not required; an input
//                  property whose `enum` only gained values (every call an old
//                  caller could make is still accepted), everything else equal
export type Tool = { name: string; inputSchema?: Record<string, any> };
export type ToolsDiff = { incompatible: string[]; added: string[]; newTools: string[] };

const noDesc = (v: unknown) => JSON.stringify(v, (k, x) => (k === "description" ? undefined : x));

/** Values added to an input enum, when that is the ONLY difference and nothing was removed; otherwise null. */
function enumWidened(base: any, cand: any): string[] | null {
  if (!Array.isArray(base?.enum) || !Array.isArray(cand?.enum)) return null;
  if (noDesc({ ...base, enum: null }) !== noDesc({ ...cand, enum: null })) return null;
  if (!base.enum.every((x: unknown) => cand.enum.includes(x))) return null;
  const plus = cand.enum.filter((x: unknown) => !base.enum.includes(x)).map(String);
  return plus.length ? plus : null;
}

export function compareTools(base: Tool[], cand: Tool[]): ToolsDiff {
  const incompatible: string[] = [], added: string[] = [];
  const byName = new Map(cand.map((t) => [t.name, t]));
  for (const t of base) {
    const n = byName.get(t.name);
    if (!n) { incompatible.push(`${t.name}: tool removed`); continue; }
    const bs = t.inputSchema ?? {}, ns = n.inputSchema ?? {};
    const bp = bs.properties ?? {}, np = ns.properties ?? {};
    for (const [k, v] of Object.entries(bp)) {
      if (!(k in np)) incompatible.push(`${t.name}.${k}: property removed`);
      else if (noDesc(v) !== noDesc(np[k])) {
        const widened = enumWidened(v, np[k]);
        if (widened) added.push(`${t.name}.${k} enum+[${widened.join(",")}]`);
        else incompatible.push(`${t.name}.${k}: retyped ${noDesc(v)} → ${noDesc(np[k])}`);
      }
    }
    const br = JSON.stringify([...(bs.required ?? [])].sort()), nr = JSON.stringify([...(ns.required ?? [])].sort());
    if (br !== nr) incompatible.push(`${t.name}: required ${br} → ${nr}`);
    for (const k of new Set([...Object.keys(bs), ...Object.keys(ns)])) {
      if (k === "properties" || k === "required" || k === "description") continue;
      if (noDesc(bs[k]) !== noDesc(ns[k])) incompatible.push(`${t.name}: inputSchema.${k} ${noDesc(bs[k])} → ${noDesc(ns[k])}`);
    }
    const plus = Object.keys(np).filter((k) => !(k in bp));
    if (plus.length) added.push(`${t.name}+[${plus.join(",")}]`);
  }
  const newTools = cand.filter((t) => !base.some((b) => b.name === t.name)).map((t) => t.name);
  return { incompatible, added, newTools };
}
