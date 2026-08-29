// #1469 finding-3 — validation for the --tools and --model flags in
// createProfileFromOpts. Before this, `--tools Bsh,Read` was silently
// accepted: the typo dropped Bash from the agent's tool allowlist and
// nothing surfaced until (much later) the model reported it couldn't find
// a tool it expected. Mirrors what #478 did for --runtime via
// normalizeRuntimeStrict: at the profile boundary, an unrecognized value
// is a typo, not an unknown future thing.
//
// SOURCE OF TRUTH — deliberate design choice:
//
//   The Claude-side tool set below reflects bin/cli.ts's own node-create
//   warning ("Claude Code preset — WebFetch / WebSearch / Bash / Read /
//   Write / Edit / Glob / Grep / Task / ..."). That warning is the
//   product's user-facing statement of the set; this file mirrors it so
//   the two sources stay aligned. Updating this list requires a real
//   Claude release adding a tool, not a whim.
//
//   Naming difference — grok's copresence profile uses lowercase_snake
//   (todo_write / search_tool / use_tool) validated against a fixed
//   3-profile allowlist in grok-copresence-disclosure.ts. codex /
//   codex-app-server / opencode-cli don't read this field. So the Claude
//   allowlist applies ONLY to claude-lineage runtimes. Every other
//   runtime gets the basic per-token format check and lets its own
//   downstream validation catch semantic issues.
//
// FAILURE MODE this file catches — the reported #1469 finding-3 shape:
//   $ anet node create foo --tools Bsh,Read
//   BEFORE: silently persists ["Bsh", "Read"]. Bash is missing.
//   AFTER:  throws "unknown Claude-side tool \"Bsh\" on runtime
//           \"claude-agent-sdk\". Expected one of: WebFetch, WebSearch,
//           Bash, ..." — user sees the typo AND the expected set.

export const CLAUDE_KNOWN_TOOLS: readonly string[] = [
  // WebFetch/WebSearch — network fetch tools
  "WebFetch", "WebSearch",
  // Shell tools (Bash + its output streaming and kill counterparts)
  "Bash", "BashOutput", "KillShell",
  // File tools — read/write, and specialty editors
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  // Filesystem search
  "Glob", "Grep",
  // Agent-level controls
  "Task", "ExitPlanMode", "TodoWrite",
] as const;

const CLAUDE_TOOLS_SET = new Set(CLAUDE_KNOWN_TOOLS);

// MCP tools follow the pattern `mcp__<server>__<tool>`. These are
// user-defined by whichever MCP server hosts them (e.g. `mcp__commhub__send_task`),
// so no static allowlist can enumerate them — accept anything shaped this
// way. The pattern is strict: exactly two double-underscore separators, and
// the server + tool segments must be non-empty identifier-shaped.
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/;

// Basic per-token format for any runtime: starts with a letter, letters/
// digits/underscore/dash only. Rejects empties, embedded whitespace,
// leading/trailing punctuation. Intentionally permissive shape-wise so
// runtimes with different naming conventions (grok's lowercase_snake)
// still pass the basic check.
const BASIC_TOOL_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

type Runtime = string;
const CLAUDE_LINEAGE: ReadonlySet<Runtime> = new Set([
  "claude-agent-sdk",
  "claude-code-cli",
]);

/** Parse the comma-joined --tools string, validate each token, return the
 * trimmed list. Runtime-scoped:
 *
 *   Claude-lineage → each token must be in CLAUDE_KNOWN_TOOLS OR match
 *                    the MCP pattern (mcp__<server>__<tool>).
 *   Other runtimes → only the basic per-token format check runs, so grok /
 *                    codex / opencode tools flow through unchanged and get
 *                    validated by their own downstream layers.
 *
 * Throws on the first offense with a message naming the bad token and,
 * for Claude-side violations, the expected set. Never returns a
 * partially-cleaned list — a typo must surface, not silently reshape the
 * persisted profile.
 */
export function parseAndValidateTools(raw: string, runtime: Runtime): string[] {
  if (typeof raw !== "string") {
    throw new Error(`--tools value must be a string, got ${typeof raw}`);
  }
  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(`--tools value ${JSON.stringify(raw)} parsed to empty list — omit --tools instead if you want the runtime default`);
  }
  const isClaudeLineage = CLAUDE_LINEAGE.has(runtime);
  for (const tok of tokens) {
    if (!BASIC_TOOL_RE.test(tok) && !MCP_TOOL_RE.test(tok)) {
      throw new Error(
        `--tools contains invalid tool name ${JSON.stringify(tok)}: ` +
        `tool names must start with a letter and use only letters, digits, hyphen, or underscore, ` +
        `or match the MCP pattern mcp__<server>__<tool>.`,
      );
    }
    if (isClaudeLineage && !CLAUDE_TOOLS_SET.has(tok) && !MCP_TOOL_RE.test(tok)) {
      throw new Error(
        `--tools contains unknown Claude-side tool ${JSON.stringify(tok)} on runtime ${JSON.stringify(runtime)}. ` +
        `Expected one of: ${CLAUDE_KNOWN_TOOLS.join(", ")}, ` +
        `or an MCP tool matching mcp__<server>__<tool>. ` +
        `(Common typos: 'Bsh' → 'Bash', 'Wr' → 'Write', 'read' → 'Read' — names are case-sensitive.)`,
      );
    }
  }
  return tokens;
}

/** Minimal --model validation: non-empty after trim, no whitespace inside.
 *
 * We do NOT enforce a known-model allowlist — models are vendor-defined,
 * evolve independently, and a strict list would break the first time
 * MiniMax/DeepSeek/GLM/etc. ships a new variant. This catches the obvious
 * user-side typos (`--model " claude-3 " `, `--model ""`) without
 * over-restricting legitimate values. Vendor-side model resolution
 * (defaultCodexModelForRuntime etc.) already validates its own contract.
 */
export function validateModel(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error(`--model value must be a string, got ${typeof raw}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`--model value ${JSON.stringify(raw)} is empty after trim`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`--model value ${JSON.stringify(raw)} contains whitespace after trim`);
  }
  return trimmed;
}
