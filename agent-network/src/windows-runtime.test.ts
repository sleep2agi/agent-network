import { expect, test } from "bun:test";
import { windowsRuntimeSupported } from "./windows-runtime.js";
import { windowsRuntimeSupported as daemonSupports } from "../../agent-node/src/shared/windows-runtime.js";

test("Windows CLI and daemon agree on SDK-only first-run support", () => {
  for (const runtime of ["claude-agent-sdk", "claude-code-cli", "codex-sdk", "codex-app-server", "grok-build-cli", "grok-build-acp", "opencode-cli"]) {
    expect(windowsRuntimeSupported(runtime, "win32")).toBe(runtime === "claude-agent-sdk");
    expect(daemonSupports(runtime, "win32")).toBe(windowsRuntimeSupported(runtime, "win32"));
    expect(windowsRuntimeSupported(runtime, "linux")).toBe(true);
    expect(windowsRuntimeSupported(runtime, "darwin")).toBe(true);
  }
});
