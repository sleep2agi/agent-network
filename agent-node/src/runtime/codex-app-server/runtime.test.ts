// RFC-030 — unit tests for the owned codex app-server argv builder.
// Locks the auto-approve wiring: approval_policy / sandbox_mode are passed
// as `-c` overrides only when set, in a stable order, and never leak into
// the shared-server (adopt) path.

import { describe, expect, test } from "bun:test";
import { buildOwnedAppServerArgs } from "./runtime";

const URL = "ws://127.0.0.1:24555";

describe("buildOwnedAppServerArgs", () => {
  test("no policy/sandbox → bare app-server (codex defaults apply)", () => {
    expect(buildOwnedAppServerArgs(URL)).toEqual(["app-server", "--listen", URL]);
  });

  test("approval_policy only → single -c override before --listen", () => {
    expect(buildOwnedAppServerArgs(URL, "never")).toEqual([
      "app-server", "-c", "approval_policy=never", "--listen", URL,
    ]);
  });

  test("sandbox_mode only → single -c override", () => {
    expect(buildOwnedAppServerArgs(URL, undefined, "workspace-write")).toEqual([
      "app-server", "-c", "sandbox_mode=workspace-write", "--listen", URL,
    ]);
  });

  test("auto-approve posture (never + danger-full-access) → both overrides, policy first", () => {
    expect(buildOwnedAppServerArgs(URL, "never", "danger-full-access")).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=danger-full-access",
      "--listen", URL,
    ]);
  });

  test("bounded auto-approve (never + workspace-write) → both overrides", () => {
    expect(buildOwnedAppServerArgs(URL, "never", "workspace-write")).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=workspace-write",
      "--listen", URL,
    ]);
  });

  test("--listen url is always last so it can't be swallowed by a -c value", () => {
    const args = buildOwnedAppServerArgs(URL, "on-request", "read-only");
    expect(args[args.length - 2]).toBe("--listen");
    expect(args[args.length - 1]).toBe(URL);
  });
});
