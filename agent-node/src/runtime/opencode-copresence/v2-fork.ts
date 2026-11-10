// #590: isolated building block, not a Hub/daemon entry point. Callers must
// authorize and bind the source server, node, network and directory first.
export type V2ForkResult =
  | { status: "forked"; sessionId: string }
  | { status: "rejected"; reason: "invalid_source" | "scope" }
  | { status: "unknown"; reason: "source_unavailable" | "request_failed" | "invalid_response" | "verification_failed" };

type Request = (path: string, init?: RequestInit) => Promise<any>;
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/** Never retries a fork: a failed request may already have created a child. */
export async function forkV2Session(input: {
  sourceSessionId: string;
  expectedDirectory: string;
  request: Request;
}): Promise<V2ForkResult> {
  const { sourceSessionId, expectedDirectory, request } = input;
  if (!SESSION_ID.test(sourceSessionId) || !expectedDirectory.startsWith("/")) {
    return { status: "rejected", reason: "invalid_source" };
  }
  let source: any;
  try { source = (await request(`/api/session/${sourceSessionId}`))?.data; }
  catch { return { status: "unknown", reason: "source_unavailable" }; }
  if (source?.id !== sourceSessionId || source?.location?.directory !== expectedDirectory) {
    return { status: "rejected", reason: "scope" };
  }
  let child: any;
  try {
    child = (await request(`/api/session/${sourceSessionId}/fork`, { method: "POST", body: "{}" }))?.data;
  } catch { return { status: "unknown", reason: "request_failed" }; }
  if (typeof child?.id !== "string" || !SESSION_ID.test(child.id) || child.id === sourceSessionId) {
    return { status: "unknown", reason: "invalid_response" };
  }
  try {
    const confirmed = (await request(`/api/session/${child.id}`))?.data;
    if (confirmed?.id !== child.id || confirmed?.location?.directory !== expectedDirectory) {
      return { status: "unknown", reason: "verification_failed" };
    }
  } catch { return { status: "unknown", reason: "verification_failed" }; }
  return { status: "forked", sessionId: child.id };
}
