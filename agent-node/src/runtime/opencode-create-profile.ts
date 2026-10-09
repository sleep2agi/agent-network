// #829: daemon creation must establish the same boundary as CLI saveProfile.
// Security helpers are byte-identical mirrors of agent-network/src; the CLI
// parity test guards drift while keeping both packages independently buildable.
import { homedir } from "node:os";
import {
  prepareOpencodeNodeForProfileWrite,
  readOpencodePrivateProfileFile,
  writeOpencodePrivateProfileFile,
} from "../shared/opencode-preset.js";
import {
  assertOpencodeNodeStateUntracked,
  readOpencodeRuntimeBinding,
  writeOpencodeRuntimeBinding,
} from "../shared/opencode-runtime-binding.js";

export function writeCreatedOpencodeProfile(
  nodeDir: string,
  config: Record<string, unknown>,
  bindingHome = process.env.HOME || homedir(),
): void {
  if (config.runtime !== "opencode-cli" || typeof config.node_id !== "string"
    || !config.node_id || typeof config.alias !== "string" || !config.alias) {
    throw new Error("OpenCode creation requires an explicit node identity");
  }
  prepareOpencodeNodeForProfileWrite(nodeDir);
  assertOpencodeNodeStateUntracked(nodeDir);
  const binding = readOpencodeRuntimeBinding(nodeDir, bindingHome);
  const previous = readOpencodePrivateProfileFile(nodeDir, "config.json");
  if (previous !== undefined) {
    const old = JSON.parse(previous);
    // Only an exact retry of this create request may replace credentials.
    // Do not adopt legacy/unbound state or convert another runtime implicitly.
    if (!binding || old?.runtime !== "opencode-cli"
      || old.node_id !== config.node_id || old.alias !== config.alias) {
      throw new Error("OpenCode creation refuses existing unbound or different node identity");
    }
  }
  // Existing bindings were validated above and are not overwritten on retry.
  // If the subsequent private write fails, retaining the binding fails closed;
  // never remove an identity record as an automatic error-recovery shortcut.
  if (!binding) writeOpencodeRuntimeBinding(nodeDir, bindingHome);
  writeOpencodePrivateProfileFile(nodeDir, "config.json", JSON.stringify(config, null, 2) + "\n");
}
