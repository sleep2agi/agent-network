import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("#1545 doctor daemon create-node capability wiring", () => {
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  const doctor = cli.slice(cli.indexOf("async function doctorCommand()"));

  test("doctor prints each local host_supervisor through the shared capability renderer", () => {
    expect(doctor).toContain('profile?.role === "host_supervisor"');
    expect(doctor).toContain("await fetchDaemonCapabilities()");
    expect(doctor).toContain("daemonCreateCapabilityLine(nid, fetched, nowMs)");
  });

  test("daemon list and doctor share the same describeCapability call path", () => {
    expect(cli.match(/describeCapability\(/g)?.length).toBe(1);
    expect(cli).toContain("return describeCapability(row, nowMs).line;");
  });
});
