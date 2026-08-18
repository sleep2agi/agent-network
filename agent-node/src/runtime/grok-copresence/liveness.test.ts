import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  describeGrokCopresenceLiveness,
  isNamedGrokCopresenceSocket,
  resolveGrokCopresenceHubStatus,
  type GrokCopresenceLivenessSource,
} from "./liveness";

const cleanup: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function listenUnix(path: string): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return server;
}

describe("Grok copresence liveness and hub status", () => {
  test("a missing session is never idle or working", () => {
    const liveness = describeGrokCopresenceLiveness(null);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(liveness, "working")).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(liveness, "offline")).toBe("offline");
    expect(resolveGrokCopresenceHubStatus(liveness, "error")).toBe("error");
  });

  test("named attach.sock and leader.sock plus a live composer are the only idle path", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-liveness-"));
    cleanup.push(root);
    const attachSocket = join(root, "attach.sock");
    const leaderSocket = join(root, "leader.sock");
    const relaySocket = join(root, "relay.sock");
    await listenUnix(attachSocket);
    await listenUnix(leaderSocket);
    await listenUnix(relaySocket);

    const live: GrokCopresenceLivenessSource = {
      isRunning: true,
      tuiReady: true,
      attachSocket,
      leaderSocket,
    };
    expect(isNamedGrokCopresenceSocket(attachSocket, "attach")).toBe(true);
    expect(isNamedGrokCopresenceSocket(leaderSocket, "leader")).toBe(true);
    expect(resolveGrokCopresenceHubStatus(describeGrokCopresenceLiveness(live), "idle")).toBe("idle");
    expect(resolveGrokCopresenceHubStatus(describeGrokCopresenceLiveness(live), "working")).toBe("working");

    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness({ ...live, tuiReady: false }),
      "idle",
    )).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness({ ...live, isRunning: false }),
      "idle",
    )).toBe("blocked");
    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness({ ...live, attachSocket: relaySocket }),
      "idle",
    )).toBe("blocked");

    const short: GrokCopresenceLivenessSource = {
      isRunning: true,
      tuiReady: true,
      attachSocket: join(root, "a.sock"),
      leaderSocket: join(root, "l.sock"),
    };
    expect(isNamedGrokCopresenceSocket(short.attachSocket, "attach")).toBe(true);
    expect(isNamedGrokCopresenceSocket(short.leaderSocket, "leader")).toBe(true);
    expect(resolveGrokCopresenceHubStatus(
      describeGrokCopresenceLiveness(short, () => true),
      "idle",
    )).toBe("idle");
  });

  test("a leftover non-socket file at the attach path is not present", async () => {
    const root = mkdtempSync(join(tmpdir(), "grok-liveness-file-"));
    cleanup.push(root);
    const attachSocket = join(root, "attach.sock");
    const leaderSocket = join(root, "leader.sock");
    await Bun.write(attachSocket, "not-a-socket");
    await listenUnix(leaderSocket);
    const liveness = describeGrokCopresenceLiveness({
      isRunning: true,
      tuiReady: true,
      attachSocket,
      leaderSocket,
    });
    expect(liveness.attach.present).toBe(false);
    expect(resolveGrokCopresenceHubStatus(liveness, "idle")).toBe("blocked");
  });
});
