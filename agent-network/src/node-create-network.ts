import { pickNetwork, type HubNetwork } from "./node-ls-all";

export const WRITABLE_CREATE_NETWORK_ROLES = new Set(["owner", "admin", "member"]);

export type CreateNetworkResolution =
  | { ok: true; network_id: string; network_name: string | null }
  | { ok: false; error: string };

/**
 * Resolve an explicit `--network <id|name>` flag for `anet node create`.
 *
 * Uses the same exact-id / exact-name / unique-prefix matcher as `anet node ls --all`
 * (`pickNetwork`), and refuses read-only memberships before requesting a node token.
 */
export function resolveExplicitCreateNetwork(
  networks: HubNetwork[],
  rawFlag: string | undefined,
): CreateNetworkResolution {
  const ref = typeof rawFlag === "string" ? rawFlag.trim() : "";
  if (!ref || ref === "true") {
    return { ok: false, error: "--network requires a value: --network <id|name>" };
  }
  const picked = pickNetwork(networks, ref, null);
  if (!picked.ok) return { ok: false, error: picked.error };
  const role = picked.network.member_role;
  if (role && !WRITABLE_CREATE_NETWORK_ROLES.has(role)) {
    const label = picked.network.network_name || picked.network.network_id;
    return {
      ok: false,
      error: `network "${label}" (${picked.network.network_id}) is not writable for your account (role=${role}); owner/admin/member role is required to create a node`,
    };
  }
  return {
    ok: true,
    network_id: picked.network.network_id,
    network_name: picked.network.network_name ?? null,
  };
}
