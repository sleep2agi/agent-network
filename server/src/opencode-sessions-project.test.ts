import { describe, expect, test } from "bun:test";
import { projectSession, projectSessionPage, isoFromEpochMs } from "./opencode-sessions-project.js";

const raw = {
  id: "ses_abc",
  title: "看板排查",
  projectID: "proj_1",
  model: { id: "claude-sonnet-4", providerID: "anthropic", variant: "high" },
  time: { created: 1763700000000, updated: 1763703600000, idle: 1763703000000 },
  location: { directory: "/srv/proj" },
  tokens: { input: 1000, output: 200 },
};

describe("#4821 OpenCode session 投影", () => {
  test("六个字段 + epoch ms → ISO-8601 UTC", () => {
    const s = projectSession(raw)!;
    expect(s).toEqual({
      id: "ses_abc", title: "看板排查", project_id: "proj_1",
      model: { provider: "anthropic", id: "claude-sonnet-4", variant: "high" },
      updated_at: "2025-11-21T05:40:00Z", directory: "/srv/proj",
    });
  });

  test("缺 model/variant/directory 时为 null，不编默认值", () => {
    const s = projectSession({ id: "x", title: "", time: { updated: 1763700000000 } })!;
    expect(s.model).toBeNull();
    expect(s.directory).toBeNull();
    expect(s.project_id).toBeNull();
  });

  test("updated 缺失时退化用 created；两者都无则空串", () => {
    expect(projectSession({ id: "x", time: { created: 1763700000000 } })!.updated_at).toBe("2025-11-21T04:40:00Z");
    expect(projectSession({ id: "x" })!.updated_at).toBe("");
  });

  test("空页形状 { data: [], cursor } ⇒ sessions [] 且 next_cursor 保留语义", () => {
    expect(projectSessionPage({ data: [], cursor: { previous: null, next: "c2" } })).toEqual({ sessions: [], next_cursor: "c2" });
    expect(projectSessionPage({ data: [], cursor: { previous: null, next: null } }).next_cursor).toBeNull();
  });

  test("上游形状异常（data 不是数组 / 条目不是对象）⇒ 空页而不是抛错", () => {
    expect(projectSessionPage({ data: "oops" })).toEqual({ sessions: [], next_cursor: null });
    expect(projectSessionPage({ data: [null, 3] })).toEqual({ sessions: [], next_cursor: null });
  });

  test("isoFromEpochMs 对非法值返回 null", () => {
    expect(isoFromEpochMs(0)).toBeNull();
    expect(isoFromEpochMs("1763700000000")).toBeNull();
    expect(isoFromEpochMs(NaN)).toBeNull();
  });
});
