// Exercise the production config adapter -> shared wrapper -> V2 writer -> stock HTTP.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openVettedOpenCodeCopresence, wrapSharedCopresenceSession } from "../../agent-node/src/runtime/opencode-copresence/runtime";
import { OPENCODE_V2_BACKEND } from "../../agent-node/src/runtime/opencode-backend";
import { applyVariantConfig } from "../../agent-node/src/runtime/opencode-copresence/variant-config-apply";

const [directory, sessionId] = process.argv.slice(2);
const workDir = join(directory, "combined-node");
mkdirSync(workDir);
const noTmux = () => { throw Error("tmux forbidden in test4822"); };
const core = await openVettedOpenCodeCopresence({
  backend: OPENCODE_V2_BACKEND, binary: "/tool/opencode", env: process.env,
  cwd: directory, workDir, model: "fixture/model", expectedVersion: "2.0.22",
  sharedServer: { url: "http://127.0.0.1:18543", password: "fixture4822" },
  resumeSessionId: sessionId, tmuxRunner: noTmux, tmuxRespawn: noTmux,
});
const session = wrapSharedCopresenceSession(core);
try {
  const result = await applyVariantConfig(session, { model: "fixture/other", modelVariant: "high" });
  if (result.status !== "applied" || result.model.id !== "other" || result.model.variant !== "high") throw Error(JSON.stringify(result));
  const reply = await session.submit("Return a short answer.", 30_000);
  if (!reply.replyText.includes("EFFORT_high")) throw Error("combined provider response marker missing");
  const rejected = await applyVariantConfig(session, { model: "fixture/other", modelVariant: "not-listed" });
  if (rejected.status !== "rejected" || rejected.reason !== "catalog") throw Error("unknown variant not rejected before write");
  const current = await session.selectedSessionModel!(sessionId);
  if (current?.id !== "other" || current.variant !== "high") throw Error("rejected selection changed session");
  console.log("PASS production combined config+wrapper+writer+prompt", JSON.stringify({ result, reply, rejected }));
} finally {
  await session.close();
}
