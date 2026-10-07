import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = "/repo/agent-network/src/codex-copresence-resume-timeout.ts";
const original = readFileSync(source, "utf8");
const anchor = "export const CODEX_RECOVERY_MAX_PAYLOAD_BYTES = 1536 * 1024 ** 2;";
if (!original.includes(anchor)) throw new Error("finite payload mutation anchor missing");
const home = mkdtempSync(join(tmpdir(), "test1178-node-mutation-"));
try {
  writeFileSync(source, original.replace(anchor, "export const CODEX_RECOVERY_MAX_PAYLOAD_BYTES = 100 * 1024 ** 2;"));
  const build = spawnSync("bun", ["build", "src/codex-copresence-rpc.ts", "--target", "node", "--format", "esm", "--outfile", "/repo/agent-network/.test-codex-copresence-rpc.mjs"], {
    cwd: "/repo/agent-network", encoding: "utf8",
  });
  if (build.status !== 0) throw new Error(`mutated Node bundle failed to build\n${build.stdout}\n${build.stderr}`);
  writeFileSync(join(home, "auth.json"), '{"OPENAI_API_KEY":"sk-test1178-offline"}\n');
  writeFileSync(join(home, "config.toml"), "check_for_update_on_startup = false\n");
  const result = spawnSync("node", ["/repo/real-0133-large-resume.mjs"], {
    env: { ...process.env, CODEX_HOME: home, TEST1178_ROLLOUT_MIB: "256" },
    encoding: "utf8", timeout: 300_000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !output.includes("Max payload size exceeded")) {
    throw new Error(`finite-payload mutation was not witnessed by true Node (rc=${result.status})\n${output}`);
  }
  console.log("WITNESSED_RED true Node 22 + Codex 0.133 rejects a 256 MiB rollout at a mutated 100 MiB ceiling");
} finally {
  writeFileSync(source, original);
  rmSync(home, { recursive: true, force: true });
}
