import { join } from "path";

/**
 * The one place that decides which paths a Grok CLI node hides from its
 * model tools.
 *
 * Why this is its own function (issue #885): `cli.ts` built this array inline,
 * twice, as two identical literals — and **nothing tested either of them**.
 * The sandbox mechanism below (`prepareGrokCliHome` → `sandbox.toml`) is well
 * covered, but that coverage tests the *callee*: it takes whatever `denyPaths`
 * it is handed and writes them out faithfully. A caller that forgot a path
 * would sail through every one of those tests. Reviewing the mechanism cannot
 * catch a caller bug; only a test that looks at what the caller passes can.
 *
 * So: one function, one test file, and both call sites go through here.
 */
export interface GrokCliDenyPathsInput {
  /** The project directory Grok is trusted in. */
  readonly projectCwd: string;
  /** The operating-system user's home directory. */
  readonly userHome: string;
  /** The node's own config file, when it has one. */
  readonly nodeConfigPath?: string;
}

export function grokCliDenyPaths(input: GrokCliDenyPathsInput): string[] {
  return [
    join(input.projectCwd, ".anet"),
    join(input.userHome, ".anet"),
    input.nodeConfigPath || "",
    join(input.projectCwd, ".mcp.json"),
  ];
}
