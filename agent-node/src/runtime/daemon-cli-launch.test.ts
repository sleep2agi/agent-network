import { expect, test } from "bun:test";
import { daemonCliLaunch } from "./daemon-cli-launch.js";

test("Windows JS pin uses the running private Node, without shell quoting", () => {
  const pin = 'C:\\App data & files\\anet.cjs';
  expect(daemonCliLaunch(pin, ["node", "start", "safe-name"], "win32", 'C:\\Private Node\\node.exe')).toEqual({
    command: 'C:\\Private Node\\node.exe', args: [pin, "node", "start", "safe-name"],
  });
});
test("native executables and POSIX shebang launching remain unchanged", () => {
  expect(daemonCliLaunch('C:\\anet.exe', ["daemon"], "win32")).toEqual({ command: 'C:\\anet.exe', args: ["daemon"] });
  expect(daemonCliLaunch('/opt/anet.cjs', ["daemon"], "linux")).toEqual({ command: '/opt/anet.cjs', args: ["daemon"] });
});
