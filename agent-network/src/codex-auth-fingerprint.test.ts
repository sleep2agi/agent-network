import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  CODEX_AUTH_FINGERPRINT_FILE,
  FINGERPRINT_LENGTH,
  collidingNodes,
  describeCodexRefreshFailure,
  fingerprintRefreshToken,
  sharedCredentialWarningLines,
  type NodeFingerprint,
} from "./codex-auth-fingerprint";

/** The shape codex actually writes (verified against a live auth.json on DEV:
 *  auth_mode + tokens{id_token, access_token, refresh_token, account_id} + last_refresh). */
const nested = (refresh: string) => JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "ID", access_token: "AT", refresh_token: refresh, account_id: "e93e8b3e-faed-499b-8a2f-d06a412bc601" },
  last_refresh: "2026-09-17T08:00:39.781354257Z",
});

describe("fingerprintRefreshToken", () => {
  test("same token → same fingerprint (this is what makes a collision detectable)", () => {
    expect(fingerprintRefreshToken(nested("rt-alpha"))).toBe(fingerprintRefreshToken(nested("rt-alpha")));
  });

  test("different tokens → different fingerprints", () => {
    expect(fingerprintRefreshToken(nested("rt-alpha"))).not.toBe(fingerprintRefreshToken(nested("rt-beta")));
  });

  test("reads the top-level shape too", () => {
    const top = JSON.stringify({ refresh_token: "rt-alpha" });
    expect(fingerprintRefreshToken(top)).toBe(fingerprintRefreshToken(nested("rt-alpha")));
  });

  test("nested wins when both are present (nested is the live shape)", () => {
    const both = JSON.stringify({ refresh_token: "rt-stale", tokens: { refresh_token: "rt-live" } });
    expect(fingerprintRefreshToken(both)).toBe(fingerprintRefreshToken(nested("rt-live")));
  });

  test("is exactly FINGERPRINT_LENGTH hex chars", () => {
    const fp = fingerprintRefreshToken(nested("rt-alpha"))!;
    expect(fp).toMatch(/^[0-9a-f]+$/);
    expect(fp.length).toBe(FINGERPRINT_LENGTH);
  });

  test("🔴 never contains the token — the whole point of hashing it", () => {
    const secret = "sk-super-secret-refresh-token-value";
    const fp = fingerprintRefreshToken(nested(secret))!;
    expect(fp).not.toContain(secret);
    expect(fp).not.toContain(secret.slice(0, 8));
    expect(secret).not.toContain(fp);
  });

  test("unreadable input is null, not a guess", () => {
    expect(fingerprintRefreshToken("")).toBeNull();
    expect(fingerprintRefreshToken("{not json")).toBeNull();
    expect(fingerprintRefreshToken("[]")).toBeNull();
    expect(fingerprintRefreshToken("null")).toBeNull();
    expect(fingerprintRefreshToken(JSON.stringify({ auth_mode: "chatgpt" }))).toBeNull();
    expect(fingerprintRefreshToken(JSON.stringify({ tokens: { refresh_token: "" } }))).toBeNull();
    expect(fingerprintRefreshToken(JSON.stringify({ tokens: { refresh_token: 42 } }))).toBeNull();
    expect(fingerprintRefreshToken(JSON.stringify({ tokens: null }))).toBeNull();
  });

  test("the record file sits next to the node's other state files", () => {
    expect(CODEX_AUTH_FINGERPRINT_FILE).toBe(".codex-auth-fingerprint.json");
  });
});

const rec = (alias: string, fingerprint: string | null): NodeFingerprint => ({ alias, fingerprint });

describe("collidingNodes", () => {
  test("finds the other nodes on the same chain", () => {
    const self = rec("通信牛", "aaaaaaaa");
    const all = [self, rec("TMAI负责人", "aaaaaaaa"), rec("TM运维", "aaaaaaaa"), rec("别的节点", "bbbbbbbb")];
    expect(collidingNodes(all, self).map((r) => r.alias)).toEqual(["TMAI负责人", "TM运维"]);
  });

  test("excludes self even when its own record is in the list", () => {
    const self = rec("通信牛", "aaaaaaaa");
    expect(collidingNodes([self], self)).toEqual([]);
  });

  test("unknown fingerprints are not matches — on either side", () => {
    const self = rec("通信牛", "aaaaaaaa");
    expect(collidingNodes([self, rec("无凭据", null)], self)).toEqual([]);
    expect(collidingNodes([rec("别人", "aaaaaaaa")], rec("通信牛", null))).toEqual([]);
  });
});

describe("sharedCredentialWarningLines — two-way", () => {
  test("same fingerprint ⇒ warns, names the other alias, and says what will happen", () => {
    const self = rec("通信牛", "aaaaaaaa");
    const lines = sharedCredentialWarningLines(self, [rec("TM运维", "aaaaaaaa"), rec("TMAI负责人", "aaaaaaaa")]);
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(text).toContain("通信牛");
    expect(text).toContain("TM运维");
    expect(text).toContain("TMAI负责人");
    expect(text).toContain("aaaaaaaa");
    expect(text).toContain("already used");
    expect(text).toContain("#1918");
    // The remedy has to be in there, or the warning is just alarming.
    expect(text).toMatch(/device-auth|own login/);
  });

  test("🔴 different fingerprints ⇒ no output at all (the quiet side is a real assertion)", () => {
    const self = rec("通信牛", "aaaaaaaa");
    expect(sharedCredentialWarningLines(self, collidingNodes([self, rec("别的节点", "bbbbbbbb")], self))).toEqual([]);
  });

  test("a node whose own fingerprint is unknown says nothing", () => {
    const self = rec("通信牛", null);
    expect(sharedCredentialWarningLines(self, collidingNodes([self, rec("别的节点", "bbbbbbbb")], self))).toEqual([]);
  });
});

describe("the launcher actually calls this (source contract)", () => {
  // A pure module nothing calls is a fix that always takes its no-op branch.
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf-8").replace(/\r\n?/g, "\n");

  test("the copresence start path checks for a shared login after staging", () => {
    expect(cli).toContain("checkCodexCredentialSharingForNode(resolved.id, displayName, opts.codexHome)");
    // …and it must run AFTER staging, or it fingerprints a file that is about to change.
    expect(cli.indexOf("checkCodexCredentialSharingForNode(resolved.id"))
      .toBeGreaterThan(cli.indexOf("staged ${step.name} into the node CODEX_HOME"));
  });

  // 🔴 This CLI is only ONE of the two ways a codex node starts, and on a real
  //    35-node fleet it was the minority one (4 of 35; the other 31 run
  //    agent-node straight from a script). The logic therefore lives in the
  //    shared module — if this call site ever re-grows its own copy of the
  //    read/record/compare steps, the two paths can drift and only one gets fixed.
  test("the launcher delegates instead of carrying its own copy of the logic", () => {
    const fn = cli.slice(
      cli.indexOf("function checkCodexCredentialSharingForNode"),
      cli.indexOf("function persistCodexRecoveryPoint"),
    );
    expect(fn).toContain("checkCodexCredentialSharing({");
    for (const owned of ["readdirSync(", "fingerprintRefreshToken(", "collidingNodes(", "sharedCredentialWarningLines("]) {
      expect(fn).not.toContain(owned);
    }
  });

  test("both app-server failure paths explain a spent refresh token", () => {
    expect(cli.match(/describeCodexRefreshFailure\(/g)?.length).toBe(2);
    expect(cli).toContain("describeCodexRefreshFailure(capturePane(appsrvSession, 200)");
    expect(cli).toContain("describeCodexRefreshFailure(appLogTail)");
  });

  test("the warning never refuses to start", () => {
    const fn = cli.slice(cli.indexOf("function checkCodexCredentialSharingForNode"), cli.indexOf("function persistCodexRecoveryPoint"));
    expect(fn).not.toContain("process.exit");
  });
});

describe("describeCodexRefreshFailure — two shapes, two remedies", () => {
  // Both sentences are upstream's own, captured on a live host.
  const reuse = "ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
  const transport = "Failed to refresh token: error sending request for url (https://auth.openai.com/oauth/token)";

  test("A rotation conflict is named as one, and points at THIS node's login", () => {
    const f = describeCodexRefreshFailure(reuse, [rec("TM运维", "aaaaaaaa")])!;
    const text = f.lines.join("\n");
    expect(f.kind).toBe("rotation-conflict");
    expect(text).toContain("TM运维");
    expect(text).toContain("one-time");
    expect(text).toContain("app-server");
    expect(text).toContain("idle");
    expect(text).toContain("#1918");
  });

  test("a rotation conflict still explains itself when the peer is unknown", () => {
    const text = describeCodexRefreshFailure(reuse)!.lines.join("\n");
    expect(text).toContain("same codex login");
    expect(text).toContain("log in again");
  });

  test("🔴 a transport failure is a DIFFERENT cause with a DIFFERENT remedy", () => {
    const f = describeCodexRefreshFailure(transport)!;
    const text = f.lines.join("\n");
    expect(f.kind).toBe("token-endpoint-unreachable");
    // egress, not credentials
    expect(text).toContain("egress");
    expect(text).toMatch(/proxy|allowlist/);
    // …and it must say the tempting "fix" is not one, because that is what
    // creates the shared-credential chain in the first place.
    expect(text).toContain("NOT a fix");
    expect(text).toContain("auth.json");
    // it must NOT tell the operator their token was spent by a peer
    expect(text).not.toContain("already spent");
    expect(text).not.toContain("log in again");
  });

  test("🔴 the two shapes never collapse into each other", () => {
    expect(describeCodexRefreshFailure(reuse)!.kind).not.toBe(describeCodexRefreshFailure(transport)!.kind);
  });

  test("survives a re-wording of each", () => {
    expect(describeCodexRefreshFailure("refresh_token has already been used by another client")!.kind).toBe("rotation-conflict");
    expect(describeCodexRefreshFailure("Failed to refresh token: error sending request (connection refused)")!.kind).toBe("token-endpoint-unreachable");
  });

  test("🔴 an unrelated error passes through unchanged (null, so the caller keeps its own text)", () => {
    expect(describeCodexRefreshFailure("app-server did not bind ws://127.0.0.1:1455 within 25s")).toBeNull();
    expect(describeCodexRefreshFailure("Error: ENOENT: no such file or directory, open 'auth.json'")).toBeNull();
    expect(describeCodexRefreshFailure("429 rate limit exceeded")).toBeNull();
    expect(describeCodexRefreshFailure("")).toBeNull();
  });
});
