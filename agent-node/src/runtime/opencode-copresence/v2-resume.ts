import { isV2SessionScope } from "./v2-model-selection";
/** Existing V2 resume protocol: GET the exact session, never create/fork/model
 * reconcile as fallback. Returning this handle does not spawn another bridge. */
export async function resumeV2Session(input: { sessionId: string; directory: string;
  request: (path: string) => Promise<any> }): Promise<any> {
  if (!/^ses_[A-Za-z0-9]+$/.test(input.sessionId)) throw Error("Invalid OpenCode v2 session id to resume");
  const body = await input.request(`/api/session/${input.sessionId}`);
  if (typeof body?.data?.id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(body.data.id)) throw Error("OpenCode v2 session resume response returned an invalid session id");
  if (body.data.id !== input.sessionId) throw Error("OpenCode v2 resumed session id does not match the requested session");
  if (!isV2SessionScope(body, input.sessionId, input.directory)) throw Error("OpenCode v2 session directory does not match the node workspace");
  return body;
}
