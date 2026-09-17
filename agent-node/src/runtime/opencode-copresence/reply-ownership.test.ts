import { describe, expect, test } from "bun:test";
import { isHumanUserMessage, ownershipChainVerdict, unverifiedOwnerError } from "./reply-ownership";
import { runtimeErrorReplyText, UNVERIFIED_OWNER_MARKER } from "../unverified-reply-text";

const user = (id: string, parentID?: string, text = "hi") => ({ info: { id, role: "user", parentID }, parts: [{ type: "text", text }] });
const summary = (id: string, parentID: string) => ({ info: { id, role: "user", parentID, summary: true }, parts: [{ type: "compaction" }] });
const assistant = (id: string, parentID: string) => ({ info: { id, role: "assistant", parentID }, parts: [{ type: "text", text: "a" }] });

describe("ownershipChainVerdict (#1910)", () => {
  test("direct parent is accepted with zero hops", () => {
    expect(ownershipChainVerdict([], "msg_sub", "msg_sub")).toEqual({ accepted: true, hops: 0 });
  });
  test("summary continuation between reply and submission is accepted", () => {
    const history = [user("msg_sub"), summary("msg_sum", "msg_sub"), assistant("msg_a", "msg_sum")];
    expect(ownershipChainVerdict(history, "msg_sub", "msg_sum")).toEqual({ accepted: true, hops: 1 });
  });
  test("two chained summaries are accepted", () => {
    const history = [user("msg_sub"), summary("s1", "msg_sub"), summary("s2", "s1")];
    expect(ownershipChainVerdict(history, "msg_sub", "s2")).toEqual({ accepted: true, hops: 2 });
  });
  test("a human text user message in the chain is refused", () => {
    const history = [user("msg_sub"), user("msg_human", "msg_sub", "typed by human")];
    const v = ownershipChainVerdict(history, "msg_sub", "msg_human");
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.reason).toContain("human message msg_human");
  });
  test("a parent missing from history is refused", () => {
    const v = ownershipChainVerdict([user("msg_sub")], "msg_sub", "msg_ghost");
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.reason).toContain("not found");
  });
  test("a chain that ends without reaching the submission is refused", () => {
    const history = [summary("s1", "msg_other")];
    const v = ownershipChainVerdict(history, "msg_sub", "s1");
    expect(v.accepted).toBe(false);
  });
  test("a loop is refused instead of spinning", () => {
    const history = [summary("s1", "s2"), summary("s2", "s1")];
    const v = ownershipChainVerdict(history, "msg_sub", "s1");
    expect(v.accepted).toBe(false);
    if (!v.accepted) expect(v.reason).toContain("loops");
  });
  test("isHumanUserMessage heuristic", () => {
    expect(isHumanUserMessage(user("x"), "sub")).toBe(true);
    expect(isHumanUserMessage(user("sub"), "sub")).toBe(false);
    expect(isHumanUserMessage(summary("s", "sub"), "sub")).toBe(false);
    expect(isHumanUserMessage({ info: { id: "u", role: "user" }, parts: [{ type: "text", text: "   " }] }, "sub")).toBe(false);
    expect(isHumanUserMessage(assistant("a", "sub"), "sub")).toBe(false);
  });
});

describe("runtimeErrorReplyText (#1910 floor)", () => {
  test("plain errors keep the legacy shape", () => {
    expect(runtimeErrorReplyText("opencode", new Error("boom"))).toBe("opencode 错误: boom");
  });
  test("unverified reply text is appended under the marker with the reason", () => {
    const err = unverifiedOwnerError("DONE: pushed the repo", "msg_sum", "msg_sub", "parent chain passes through human message msg_h");
    const text = runtimeErrorReplyText("opencode", err);
    expect(text.startsWith("opencode 错误: OpenCode reply was not owned by the submitted network message")).toBe(true);
    expect(text).toContain(UNVERIFIED_OWNER_MARKER);
    expect(text).toContain("DONE: pushed the repo");
    expect(text).toContain("human message msg_h");
  });
  test("empty unverified text does not add the marker", () => {
    const err = unverifiedOwnerError("   ", undefined, "msg_sub", "r");
    expect(runtimeErrorReplyText("opencode", err)).not.toContain(UNVERIFIED_OWNER_MARKER);
  });
});
