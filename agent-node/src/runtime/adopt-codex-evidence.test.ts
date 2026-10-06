import { expect, test } from "bun:test";
import { CODEX_STOP_ORDER, verifyCodexPanes, type CodexPaneSnapshot } from "./adopt-codex-evidence.js";

const scope = { layout:"native" as const, alias: "示例", socket: "/tmp/tmux-1000/default", marker: "node-marker", codexHome: "/work/.anet/nodes/demo/codex-home", workdir: "/work", uid: 1000 };
function fixture(): CodexPaneSnapshot[] {
  return ["示例-桥", "示例", "示例-appsrv", "示例-other"].map((sessionName, i) => ({
    socket: scope.socket, session: `$${i}`, pane: `%${i}`, sessionName,
    processes: [{ pid: 100 + i, birth: "123", uid: scope.uid, cwd: scope.workdir, argv: [],
      env: { ANET_NODE_MARKER: i === 3 ? "unrelated" : scope.marker, CODEX_HOME: scope.codexHome } }],
  }));
}
test("default socket and CJK exact names select only three owned IDs", () => {
  const result = verifyCodexPanes(scope, fixture());
  expect(CODEX_STOP_ORDER.map(role => result[role].pane)).toEqual(["%0", "%1", "%2"]);
});
test("missing or wrong marker refuses instead of trusting names/PIDs", () => {
  for (const marker of ["", "another-node"]) {
    const panes = fixture(); panes[1].processes[0].env.ANET_NODE_MARKER = marker;
    expect(() => verifyCodexPanes(scope, panes)).toThrow("adopt_codex_identity_unproven");
  }
});
test("HOME, UID and cwd are independent identity gates", () => {
  for (const field of ["home", "uid", "cwd"]) {
    const panes = fixture(), proc = panes[2].processes[0];
    if (field === "home") proc.env.CODEX_HOME = "/other";
    if (field === "uid") proc.uid++;
    if (field === "cwd") proc.cwd = "/other";
    expect(() => verifyCodexPanes(scope, panes)).toThrow("adopt_codex_identity_unproven");
  }
});
test("foreign extra pane in target session forbids session-wide action", () => {
  const panes = fixture(); panes[3].session = panes[0].session;
  expect(() => verifyCodexPanes(scope, panes)).toThrow("adopt_codex_target_ambiguous");
});
test("missing stage, foreign child, invalid generation and wrong socket refuse", () => {
  const missing = fixture(); missing.splice(0, 1);
  expect(() => verifyCodexPanes(scope, missing)).toThrow();
  const foreign = fixture(); foreign[0].processes = [...foreign[0].processes, ...foreign[3].processes];
  expect(() => verifyCodexPanes(scope, foreign)).toThrow("adopt_codex_identity_unproven");
  const generation = fixture(); generation[0].processes[0].birth = "";
  expect(() => verifyCodexPanes(scope, generation)).toThrow("adopt_codex_generation_invalid");
  expect(() => verifyCodexPanes({...scope, socket: "/another/socket"}, fixture())).toThrow();
});
