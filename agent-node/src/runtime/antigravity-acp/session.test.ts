import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { openAgyAcpSession } from "./session";

const bin = process.env.AGY_BIN ?? "";
const has = !!bin && existsSync(bin);

describe.skipIf(!has)("agy acp handshake against the real binary", () => {
  it("initializes and reports the Antigravity ACP server", async () => {
    const s = await openAgyAcpSession({ binary: bin });
    try {
      expect(s.init.protocolVersion).toBe(1);
      expect(s.init.agentInfo?.name).toContain("Antigravity ACP Server");
      expect(s.init.agentInfo?.version).toContain("1.5.13");
      expect(Array.isArray(s.init.authMethods)).toBe(true);
      expect(s.init.authMethods?.some(m => m.id === "oauth-personal")).toBe(true);
      expect(s.init.agentCapabilities).toBeTruthy();
    } finally {
      await s.close();
    }
  }, 30_000);
});
