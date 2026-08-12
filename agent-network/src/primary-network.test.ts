import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  PrimaryNetworkResolutionError,
  resolvePrimaryNetwork,
  type PrimaryNetworkFetch,
  type PrimaryNetworkResponse,
} from "./primary-network";

function fakeFetch(body: PrimaryNetworkResponse, status = 200): PrimaryNetworkFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("resolvePrimaryNetwork", () => {
  test("uses current_network even when the network list is reversed and renamed", async () => {
    const selected = await resolvePrimaryNetwork("https://hub.example", { Authorization: "Bearer test" }, fakeFetch({
      ok: true,
      current_network: "net-primary",
      networks: [
        { network_id: "net-newest", network_name: "renamed-second" },
        { network_id: "net-primary", network_name: "owner-named-primary" },
      ],
    }));

    expect(selected).toBe("net-primary");
  });

  test("fails explicitly when current_network is missing instead of guessing networks[0]", async () => {
    const result = resolvePrimaryNetwork("https://hub.example", {}, fakeFetch({
      ok: true,
      networks: [{ network_id: "net-wrong", network_name: "default" }],
    }));

    await expect(result).rejects.toBeInstanceOf(PrimaryNetworkResolutionError);
    await expect(result).rejects.toThrow("未返回 current_network");
  });

  test("turns transport and HTTP failures into explicit resolution errors", async () => {
    const offline: PrimaryNetworkFetch = async () => { throw new Error("offline"); };
    await expect(resolvePrimaryNetwork("https://hub.example", {}, offline)).rejects.toThrow("检查 Hub 连接");
    await expect(resolvePrimaryNetwork("https://hub.example", {}, fakeFetch({}, 401))).rejects.toThrow("HTTP 401");
  });
});

test("debate, demo-social, and pr-review all use the shared resolver", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf8");
  expect(cli.match(/await resolvePrimaryNetwork\(/g)?.length).toBe(3);
  expect(cli).not.toContain("default_network_id");
  expect(cli).not.toMatch(/network_name\s*===\s*["']default["']/);
});
