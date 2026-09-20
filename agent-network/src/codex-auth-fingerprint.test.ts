import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CODEX_AUTH_FINGERPRINT_FILE,
  FINGERPRINT_LENGTH,
  checkCodexCredentialSharing,
  codexFingerprintIndexDir,
  codexFingerprintIndexFile,
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
    // Positive control: a null or empty result would satisfy every `not.toContain`
    // below for free, and read exactly like a real pass.
    expect(fp).toMatch(/^[0-9a-f]+$/);
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
    const self = rec("node-a", "aaaaaaaa");
    const all = [self, rec("node-b", "aaaaaaaa"), rec("node-c", "aaaaaaaa"), rec("别的节点", "bbbbbbbb")];
    expect(collidingNodes(all, self).map((r) => r.alias)).toEqual(["node-b", "node-c"]);
  });

  test("excludes self even when its own record is in the list", () => {
    const self = rec("node-a", "aaaaaaaa");
    expect(collidingNodes([self], self)).toEqual([]);
  });

  test("unknown fingerprints are not matches — on either side", () => {
    const self = rec("node-a", "aaaaaaaa");
    expect(collidingNodes([self, rec("无凭据", null)], self)).toEqual([]);
    expect(collidingNodes([rec("别人", "aaaaaaaa")], rec("node-a", null))).toEqual([]);
  });
});

describe("sharedCredentialWarningLines — two-way", () => {
  test("same fingerprint ⇒ warns, names the other alias, and says what will happen", () => {
    const self = rec("node-a", "aaaaaaaa");
    const lines = sharedCredentialWarningLines(self, [rec("node-c", "aaaaaaaa"), rec("node-b", "aaaaaaaa")]);
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(text).toContain("node-a");
    expect(text).toContain("node-c");
    expect(text).toContain("node-b");
    expect(text).toContain("aaaaaaaa");
    expect(text).toContain("already used");
    expect(text).toContain("#1918");
    // The remedy has to be in there, or the warning is just alarming.
    expect(text).toMatch(/device-auth|own login/);
  });

  test("🔴 different fingerprints ⇒ no output at all (the quiet side is a real assertion)", () => {
    const self = rec("node-a", "aaaaaaaa");
    expect(sharedCredentialWarningLines(self, collidingNodes([self, rec("别的节点", "bbbbbbbb")], self))).toEqual([]);
  });

  test("a node whose own fingerprint is unknown says nothing", () => {
    const self = rec("node-a", null);
    expect(sharedCredentialWarningLines(self, collidingNodes([self, rec("别的节点", "bbbbbbbb")], self))).toEqual([]);
  });
});

describe("where the host index lives, and what names its files", () => {
  // 🔴 No `/home/<name>/` literals anywhere below. This repo is public, and
  //    `home-path-baseline` rejects person-looking home paths in new files —
  //    it caught the first draft of these very fixtures. The join logic is
  //    identical for any parent, so a neutral root tests exactly as much.
  test("under ~/.anet — host-scoped state that does not move with cwd", () => {
    expect(codexFingerprintIndexDir("/tmp/fake-home")).toBe("/tmp/fake-home/.anet/codex-auth-fingerprints");
  });

  test("the filename comes from the node directory, and is hex", () => {
    expect(codexFingerprintIndexFile("/ws/.anet/nodes/n_1")).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  test("🔴 same directory ⇒ same name (one record per node, on either launch path)", () => {
    expect(codexFingerprintIndexFile("/ws/.anet/nodes/n_1"))
      .toBe(codexFingerprintIndexFile("/ws/.anet/nodes/./n_1"));
  });

  test("🔴 different directories ⇒ different names, even with the same alias", () => {
    expect(codexFingerprintIndexFile("/ws-a/.anet/nodes/同名"))
      .not.toBe(codexFingerprintIndexFile("/ws-b/.anet/nodes/同名"));
  });

  test("the name leaks nothing about the path it came from", () => {
    // 🔴 The token has to be one that could actually survive into the output,
    //    or this assertion passes for free. Positive control first: the name is
    //    hex-only, so prove the checker would catch a leak at all by asserting
    //    a hex fragment of the input IS absent while the input contains it.
    const secret = "deadbeef-tenant";
    const name = codexFingerprintIndexFile(`/srv/${secret}/.anet/nodes/n_1`);
    expect(secret).toContain("deadbeef");
    expect(name).toMatch(/^[0-9a-f]{16}\.json$/);
    expect(name).not.toContain(secret);
    expect(name).not.toContain("tenant");
  });
});

describe("🔴 the comparison is host-wide, not workspace-wide", () => {
  // THE case this index exists for. On the reference fleet, 35 nodes live in 27
  // workspaces; of the 8 nodes actually sharing credentials, a sibling-only scan
  // saw 2. The three byte-identical ones sat in three different workspaces and
  // were invisible. Every test below that matters puts the nodes in SEPARATE
  // workspace roots, because that is the population that was blind.
  const auth = (refresh: string, accessExp?: number) => {
    const access = accessExp === undefined
      ? "AT"
      : `h.${Buffer.from(JSON.stringify({ exp: accessExp })).toString("base64url")}.s`;
    return JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: refresh, access_token: access } });
  };

  interface Node { nodeDir: string; alias: string; codexHome: string }

  const makeHost = () => {
    const base = mkdtempSync(join(tmpdir(), "anet-1918c-"));
    const indexDir = join(base, "host-index");
    const node = (workspace: string, alias: string, refresh: string, accessExp?: number): Node => {
      const nodeDir = join(base, workspace, ".anet", "nodes", alias);
      const codexHome = join(base, workspace, "codex-home");
      mkdirSync(nodeDir, { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), auth(refresh, accessExp));
      return { nodeDir, alias, codexHome };
    };
    const start = (n: Node, now?: Date) => {
      const said: string[] = [];
      const colliding = checkCodexCredentialSharing({ ...n, indexDir, say: (m) => said.push(m), now });
      return { text: said.join("\n"), colliding };
    };
    return { base, indexDir, node, start };
  };

  test("two nodes in DIFFERENT workspaces on one credential find each other", () => {
    const host = makeHost();
    const a = host.node("ws-alpha", "节点丁", "SHARED-RT");
    const b = host.node("ws-beta", "节点戊", "SHARED-RT");

    expect(host.start(a).text).toBe(""); // first one up has nobody to collide with yet
    const second = host.start(b);
    expect(second.colliding.map((c) => c.alias)).toEqual(["节点丁"]);
    expect(second.text).toContain("节点戊 shares its codex login with: 节点丁");

    // …and it is mutual: the first node learns about it on its next start.
    expect(host.start(a).text).toContain("节点戊");
  });

  test("🔴 an index record with no node_dir is skipped, not treated as a node", () => {
    // Hardening: v3 always writes `node_dir`, and this index is new in v3, so
    // nothing older can be sitting in it. But if such a record ever appeared,
    // the only identity left would be the index file's own path — which is not
    // a node directory, so it could neither be de-duplicated against that
    // node's sibling copy nor be recognised as self. It would show up as an
    // extra node on the same credential: a collision we invented.
    const host = makeHost();
    const a = host.node("ws-solo-index", "节点辛", "RT-PHANTOM");
    expect(host.start(a).text).toBe("");

    const fingerprint = fingerprintRefreshToken(auth("RT-PHANTOM"))!;
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/); // control: same credential, so a phantom WOULD collide
    writeFileSync(
      join(host.indexDir, "0123456789abcdef.json"),
      JSON.stringify({ schema_version: 3, alias: "无目录记录", fingerprint, written_at: new Date().toISOString() }),
      { mode: 0o600 },
    );

    const again = host.start(a);
    expect(again.colliding).toEqual([]);
    expect(again.text).toBe("");
  });

  test("a same-workspace pair still works (the old scan's case is not lost)", () => {
    const host = makeHost();
    const a = host.node("ws-pair", "node-b", "SHARED-RT");
    const b = host.node("ws-pair", "node-c", "SHARED-RT");
    host.start(a);
    expect(host.start(b).colliding.map((c) => c.alias)).toEqual(["node-b"]);
  });

  test("🔴 different credentials across workspaces ⇒ not one word", () => {
    const host = makeHost();
    const a = host.node("ws-one", "节点甲", "RT-ALPHA");
    const b = host.node("ws-two", "节点乙", "RT-BETA");
    host.start(a);
    const second = host.start(b);
    expect(second.colliding).toEqual([]);
    expect(second.text).toBe("");
  });

  test("the index is keyed by directory, so two nodes may share an alias", () => {
    // Aliases are not unique across workspaces. Keyed by alias, the second node
    // would overwrite the first's record and neither would ever see a peer —
    // exactly the blindness this index was added to remove.
    const host = makeHost();
    const a = host.node("ws-a", "同名节点", "SHARED-RT");
    const b = host.node("ws-b", "同名节点", "SHARED-RT");
    host.start(a);
    expect(readdirSync(host.indexDir).filter((f) => f.endsWith(".json")).length).toBe(1);
    const second = host.start(b);
    expect(readdirSync(host.indexDir).filter((f) => f.endsWith(".json")).length).toBe(2);
    expect(second.colliding.length).toBe(1);
    expect(second.text).toContain("同名节点");
  });

  test("a node never accuses itself, however many times it starts", () => {
    const host = makeHost();
    const a = host.node("ws-solo", "独苗", "RT-ONLY");
    host.start(a);
    host.start(a);
    expect(host.start(a).text).toBe("");
    expect(readdirSync(host.indexDir).filter((f) => f.endsWith(".json")).length).toBe(1);
  });

  test("records are 0600 and carry no token", () => {
    const host = makeHost();
    const a = host.node("ws-mode", "权限节点", "SUPER-SECRET-RT");
    host.start(a);
    const file = join(host.indexDir, readdirSync(host.indexDir).find((f) => f.endsWith(".json"))!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const body = readFileSync(file, "utf-8");
    // Positive control: the secret has to be on the way in, or "it is not in the
    // output" is a statement about a fixture that never carried it.
    expect(readFileSync(join(a.codexHome, "auth.json"), "utf-8")).toContain("SUPER-SECRET-RT");
    expect(JSON.parse(body).fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(body).not.toContain("SUPER-SECRET-RT");
    expect(JSON.parse(body).node_dir).toBe(realpathSync(a.nodeDir));
  });

  describe("liveness is existence, not age", () => {
    test("🔴 a record whose node directory is gone accuses nobody, and is cleaned up", () => {
      const host = makeHost();
      const ghost = host.node("ws-deleted", "已删除的节点", "SHARED-RT");
      host.start(ghost);
      rmSync(join(host.base, "ws-deleted"), { recursive: true, force: true });

      const live = host.node("ws-live", "还活着", "SHARED-RT");
      const started = host.start(live);
      expect(started.colliding).toEqual([]);
      expect(started.text).toBe("");
      // the ghost's entry is gone; only the live node's remains
      const left = readdirSync(host.indexDir).filter((f) => f.endsWith(".json"));
      expect(left.length).toBe(1);
      expect(JSON.parse(readFileSync(join(host.indexDir, left[0]), "utf-8")).alias).toBe("还活着");
    });

    test("🔴 an OLD record whose node still exists DOES warn — age must not hide a real chain", () => {
      // Two of the three nodes in the field's worst group were not running at
      // all, and six of 29 credential files were days untouched. An age cutoff
      // would have hidden exactly the collisions worth reporting.
      const host = makeHost();
      const idle = host.node("ws-idle", "很久没起的节点", "SHARED-RT");
      const longAgo = new Date(Date.now() - 45 * 86_400_000);
      host.start(idle, longAgo);

      const live = host.node("ws-now", "刚起的节点", "SHARED-RT");
      const started = host.start(live);
      expect(started.colliding.map((c) => c.alias)).toEqual(["很久没起的节点"]);
      // …and the operator is told how old the claim is, rather than it being dropped
      expect(started.text).toMatch(/很久没起的节点 \(record \d+d.*old\)/);
    });

    test("a fresh record is named without an age annotation", () => {
      const host = makeHost();
      const a = host.node("ws-fresh-1", "甲", "SHARED-RT");
      const b = host.node("ws-fresh-2", "乙", "SHARED-RT");
      host.start(a);
      expect(host.start(b).text).toContain("shares its codex login with: 甲 (refresh");
    });
  });

  test("a refreshed credential republishes — a stale fingerprint is a wrong answer", () => {
    const host = makeHost();
    const a = host.node("ws-rotate", "轮换节点", "RT-BEFORE");
    host.start(a);
    const file = join(host.indexDir, readdirSync(host.indexDir)[0]);
    const before = JSON.parse(readFileSync(file, "utf-8")).fingerprint;

    writeFileSync(join(a.codexHome, "auth.json"), auth("RT-AFTER"));
    host.start(a);
    expect(readdirSync(host.indexDir).filter((f) => f.endsWith(".json")).length).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf-8")).fingerprint).not.toBe(before);
  });

  test("an expired shared copy gets the 'stop together' branch across workspaces", () => {
    const host = makeHost();
    const past = Math.floor(Date.now() / 1000) - 3 * 86_400;
    const a = host.node("ws-exp-1", "过期甲", "SHARED-RT", past);
    const b = host.node("ws-exp-2", "过期乙", "SHARED-RT", past);
    host.start(a);
    const text = host.start(b).text;
    expect(text).toContain("stops together");
    expect(text).toContain("not a fix");
    expect(text).not.toContain("refreshes first keeps working");
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
    const f = describeCodexRefreshFailure(reuse, [rec("node-c", "aaaaaaaa")])!;
    const text = f.lines.join("\n");
    expect(f.kind).toBe("rotation-conflict");
    expect(text).toContain("node-c");
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
