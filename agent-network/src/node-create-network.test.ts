import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveExplicitCreateNetwork } from "./node-create-network";
import { COMMAND_HELP } from "./cli-help";

const NETWORKS = [
  { network_id: "net_alpha_111111", network_name: "Alpha Team", member_role: "owner" },
  { network_id: "net_beta_222222", network_name: "Beta Lab", member_role: "member" },
  { network_id: "net_gamma_333333", network_name: "Read Only Net", member_role: "viewer" },
  { network_id: "net_dup_444444", network_name: "Shared", member_role: "admin" },
  { network_id: "net_dup_555555", network_name: "Shared", member_role: "admin" },
];

describe("resolveExplicitCreateNetwork", () => {
  test("resolves by exact network_id, exact network_name, or unique id prefix", () => {
    expect(resolveExplicitCreateNetwork(NETWORKS, "net_beta_222222")).toEqual({
      ok: true,
      network_id: "net_beta_222222",
      network_name: "Beta Lab",
    });
    expect(resolveExplicitCreateNetwork(NETWORKS, "Alpha Team")).toEqual({
      ok: true,
      network_id: "net_alpha_111111",
      network_name: "Alpha Team",
    });
    expect(resolveExplicitCreateNetwork(NETWORKS, "net_beta_")).toEqual({
      ok: true,
      network_id: "net_beta_222222",
      network_name: "Beta Lab",
    });
  });

  test("rejects missing value, unknown network, ambiguous name/prefix, and read-only role", () => {
    const missing = resolveExplicitCreateNetwork(NETWORKS, "true");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("--network <id|name>");

    const empty = resolveExplicitCreateNetwork(NETWORKS, "   ");
    expect(empty.ok).toBe(false);

    const unknown = resolveExplicitCreateNetwork(NETWORKS, "does-not-exist");
    expect(unknown.ok).toBe(false);

    const dupName = resolveExplicitCreateNetwork(NETWORKS, "Shared");
    expect(dupName.ok).toBe(false);
    if (!dupName.ok) expect(dupName.error).toContain("matches 2 networks");

    const dupPrefix = resolveExplicitCreateNetwork(NETWORKS, "net_dup_");
    expect(dupPrefix.ok).toBe(false);
    if (!dupPrefix.ok) expect(dupPrefix.error).toContain("ambiguous");

    const readonly = resolveExplicitCreateNetwork(NETWORKS, "Read Only Net");
    expect(readonly.ok).toBe(false);
    if (!readonly.ok) expect(readonly.error).toContain("not writable");
  });

  test("allows networks when member_role is absent (delegates authz to Hub)", () => {
    expect(resolveExplicitCreateNetwork([{ network_id: "net_legacy", network_name: "Legacy" }], "Legacy")).toEqual({
      ok: true,
      network_id: "net_legacy",
      network_name: "Legacy",
    });
  });

  test("CLI help and createCommand wire --network <id|name> into node-token request", () => {
    expect(COMMAND_HELP["node create"]).toContain("--network <id|name>");
    const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
    expect(cli).toContain("resolveExplicitCreateNetwork(");
    expect(cli).toContain("network_id: targetNetworkId");
  });
});
