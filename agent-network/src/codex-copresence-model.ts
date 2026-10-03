import { DEFAULT_CODEX_MODEL } from "./codex-model-default";

/**
 * #512 — which model a codex co-presence start runs on, and why.
 *
 * Order: explicit `--model` flag > the node's own config (`model` in
 * .anet/nodes/<id>/config.json, written by `anet node create --model` /
 * `anet node edit --model`) > DEFAULT_CODEX_MODEL.
 *
 * The bug this replaces: the start path computed `opts.model || DEFAULT`
 * where `opts.model` was ONLY the CLI flag, so every start that did not
 * repeat `--model` — the plain `anet node start <name>`, the boot sweep, and
 * `anet node codex start|restart|resume` (which re-invoke `node start`
 * without `--model`) — silently put the node on the default.
 *
 * One resolved value feeds all three pieces (app-server `-c model=`, the
 * thread/resume `model` override, TUI `-m`), so they cannot disagree.
 */
export type CodexModelSource = "flag" | "node-config" | "default";

export interface ResolvedCodexModel {
  model: string;
  source: CodexModelSource;
}

function usable(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

export function resolveCodexCopresenceModel(
  flagModel: unknown,
  nodeConfigModel: unknown,
  fallback: string = DEFAULT_CODEX_MODEL,
): ResolvedCodexModel {
  const flag = usable(flagModel);
  if (flag) return { model: flag, source: "flag" };
  const cfg = usable(nodeConfigModel);
  if (cfg) return { model: cfg, source: "node-config" };
  return { model: fallback, source: "default" };
}

export function describeCodexModelSource(r: ResolvedCodexModel): string {
  switch (r.source) {
    case "flag": return "--model flag";
    case "node-config": return "node config (config.json `model`)";
    default: return "built-in default (no --model, node config has no `model`)";
  }
}
