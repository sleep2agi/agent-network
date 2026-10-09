import { expect, test } from "bun:test";
import { buildAnetArgs, RUNTIMES } from "../../server/src/create-node-validate";
import { buildAnetArgsDaemon, childConfigFieldsFromSpec } from "../../agent-node/src/runtime/create-node-daemon";

const spec = { name: "v2-child", runtime: "opencode-cli" as const, model: "stub/model" };
const valid = { opencodeGeneration: "v2", opencodeUnsafeTools: true };

test("Hub and daemon produce identical CLI-compatible V2 argv", () => {
  const expected = ["node", "create", "v2-child", "--runtime", "opencode-cli", "--model", "stub/model", "--opencode-generation", "v2", "--opencode-unsafe-tools"];
  expect(buildAnetArgs({ ...spec, flags: valid })).toEqual(expected);
  expect(buildAnetArgsDaemon({ ...spec, flags: valid })).toEqual(expected);
});

for (const flags of [
  { opencodeGeneration: "v3" }, { opencodeGeneration: null },
  { opencodeGeneration: "v2" }, { opencodeGeneration: "v2", opencodeUnsafeTools: false },
  { opencodeGeneration: "v2", opencodeUnsafeTools: "true" },
  { opencodeGeneration: "v1", opencodeUnsafeTools: true },
  { opencodeGeneration: "v1", opencodeUnsafeTools: false },
  { opencodeUnsafeTools: true }, { opencodeUnsafeTools: false },
]) {
  test("both validators reject " + JSON.stringify(flags), () => {
    expect(() => buildAnetArgs({ ...spec, flags })).toThrow();
    expect(() => buildAnetArgsDaemon({ ...spec, flags })).toThrow();
    expect(() => childConfigFieldsFromSpec({ ...spec, flags })).toThrow();
  });
}
for (const runtime of RUNTIMES.filter(r => r !== "opencode-cli")) {
  test("generation controls never leak to " + runtime, () => {
    expect(() => buildAnetArgs({ ...spec, runtime, flags: valid })).toThrow();
    expect(() => buildAnetArgsDaemon({ ...spec, runtime, flags: valid })).toThrow();
  });
}
test("legacy omission and explicit V1 remain safe and do not mutate the spec", () => {
  const flags = Object.freeze({ opencodeGeneration: "v1", timeout: 600000 });
  expect(childConfigFieldsFromSpec({ ...spec, flags })).toEqual({ opencodeGeneration: "v1", flags: { timeout: 600000 } });
  expect(flags.opencodeGeneration).toBe("v1");
  expect(childConfigFieldsFromSpec(spec)).toEqual({ flags: {} });
  expect(buildAnetArgs(spec)).toEqual(buildAnetArgsDaemon(spec));
  expect(buildAnetArgs({ ...spec, flags })).toEqual(buildAnetArgsDaemon({ ...spec, flags }));
});
