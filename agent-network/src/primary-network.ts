export interface PrimaryNetworkResponse {
  ok?: boolean;
  current_network?: unknown;
  networks?: unknown;
}

export type PrimaryNetworkFetch = (
  input: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<PrimaryNetworkResponse> }>;

export class PrimaryNetworkResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrimaryNetworkResolutionError";
  }
}

/**
 * Resolve the authenticated user's active network from the server's explicit
 * `/api/auth/me.current_network` field.
 *
 * Do not fall back to a network name or list position: both are presentation
 * details, and guessing either can silently run a command in the wrong network.
 */
export async function resolvePrimaryNetwork(
  hub: string,
  headers: Record<string, string>,
  fetchImpl: PrimaryNetworkFetch = fetch as PrimaryNetworkFetch,
): Promise<string> {
  let response: Awaited<ReturnType<PrimaryNetworkFetch>>;
  try {
    response = await fetchImpl(`${hub}/api/auth/me`, { headers });
  } catch (cause) {
    throw new PrimaryNetworkResolutionError("无法读取当前 network，请检查 Hub 连接后重试。", { cause });
  }

  if (!response.ok) {
    throw new PrimaryNetworkResolutionError(`无法读取当前 network：Hub 返回 HTTP ${response.status}。`);
  }

  let body: PrimaryNetworkResponse;
  try {
    body = await response.json();
  } catch (cause) {
    throw new PrimaryNetworkResolutionError("无法读取当前 network：Hub 返回了无效响应。", { cause });
  }

  const networkId = typeof body.current_network === "string" ? body.current_network.trim() : "";
  if (!networkId) {
    throw new PrimaryNetworkResolutionError(
      "Hub 未返回 current_network，无法安全选择 network；请重新登录或用 --network <id> 明确指定。",
    );
  }
  return networkId;
}
