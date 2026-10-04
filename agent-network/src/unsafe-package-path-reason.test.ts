import { expect, test } from "bun:test";
import { classifyUnsafePath, describeUnsafeDirectory, describeUnsafePath } from "./unsafe-package-path-reason";

const ME = 1000;

// Exactly what `npx -y @sleep2agi/agent-node@preview` left on this machine on
// 2026-08-17, measured with stat: umask 0002 → dist/cli.js 0775, package.json
// 0664, both owned by uid 1000. Owner is fine; only the group-write bit fails.
const NPM_EXTRACTED_BIN = { uid: ME, mode: 0o775, processUid: ME };
const NPM_EXTRACTED_JSON = { uid: ME, mode: 0o664, processUid: ME };

test("the condition that actually fires on a umask-0002 box is group-write, not ownership", () => {
  expect(classifyUnsafePath(NPM_EXTRACTED_BIN)).toBe("group-writable");
  expect(classifyUnsafePath(NPM_EXTRACTED_JSON)).toBe("group-writable");
});

test("a correctly-extracted package passes", () => {
  expect(classifyUnsafePath({ uid: ME, mode: 0o755, processUid: ME })).toBeNull();
  expect(classifyUnsafePath({ uid: ME, mode: 0o644, processUid: ME })).toBeNull();
});

test("someone else's payload is reported as ownership, and outranks the mode bits", () => {
  expect(classifyUnsafePath({ uid: 0, mode: 0o777, processUid: ME })).toBe("owner");
});

test("world-writable is called out separately from group-writable", () => {
  expect(classifyUnsafePath({ uid: ME, mode: 0o666, processUid: ME })).toBe("world-writable");
  expect(classifyUnsafePath({ uid: ME, mode: 0o757, processUid: ME })).toBe("world-writable");
});

test("the message names the path, the mode, and umask — the thing the old text hid", () => {
  const msg = describeUnsafePath("/home/x/.npm/_npx/aa/node_modules/@sleep2agi/agent-node/dist/cli.js", NPM_EXTRACTED_BIN);
  expect(msg).toContain("/dist/cli.js");
  expect(msg).toContain("775");
  expect(msg).toContain("group-writable");
  expect(msg).toContain("umask");
  expect(msg).toContain("chmod -R g-w,o-w");
});

test("an ownership failure does not send the reader chasing umask", () => {
  const msg = describeUnsafePath("/opt/pkg/dist/cli.js", { uid: 0, mode: 0o755, processUid: ME });
  expect(msg).toContain("uid 0");
  expect(msg).not.toContain("umask");
});

test("the mode is printed octal and zero-padded, so 0644 never reads as 420", () => {
  expect(describeUnsafePath("/p", { uid: ME, mode: 0o066, processUid: ME })).toContain("066");
});

// #535 — the directory branch used to throw with no path at all.

test("#535 a sticky world-writable ancestor (/tmp) is named, and the fix is the npm cache, not chmod", () => {
  const msg = describeUnsafeDirectory("/tmp", { uid: 0, mode: 0o41777, processUid: ME, ancestorOf: "/tmp/h/.npm/_npx/aa/node_modules/@sleep2agi/agent-node/dist" });
  expect(msg).toContain("directory /tmp");
  expect(msg).toContain("1777");
  expect(msg).toContain("an ancestor of the agent-node package at /tmp/h/.npm");
  expect(msg).toContain("npm_config_cache");
  expect(msg).toContain("Do NOT chmod");
});

test("#535 a group-writable package directory gets the exact chmod for that path", () => {
  const msg = describeUnsafeDirectory("/home/x/.npm/_npx/aa/node_modules/@sleep2agi/agent-node/dist", { uid: ME, mode: 0o40775, processUid: ME });
  expect(msg).toContain("chmod g-w /home/x/.npm/_npx/aa/node_modules/@sleep2agi/agent-node/dist");
});

test("#535 a directory owned by another account names the uid and the chown", () => {
  const msg = describeUnsafeDirectory("/srv/pkgs", { uid: ME + 7, mode: 0o40755, processUid: ME });
  expect(msg).toContain(`uid ${ME + 7}`);
  expect(msg).toContain("chown $(id -u) /srv/pkgs");
});

test("#535 the file branch prints the real package root, not a <package root> placeholder", () => {
  const msg = describeUnsafePath("/home/x/.npm/_npx/aa/node_modules/@sleep2agi/agent-node/dist/cli.js", NPM_EXTRACTED_BIN);
  expect(msg).toContain("chmod -R g-w,o-w /home/x/.npm/_npx/aa/node_modules/@sleep2agi/agent-node`");
  expect(msg).not.toContain("<package root>");
});
