import fs from "node:fs";

const schema = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const defs = schema.definitions ?? {};
const methods = new Set();
const visit = (value) => {
  if (!value || typeof value !== "object") return;
  if (value.const && typeof value.const === "string") methods.add(value.const);
  if (Array.isArray(value.enum)) {
    for (const member of value.enum) if (typeof member === "string") methods.add(member);
  }
  for (const child of Object.values(value)) visit(child);
};
visit(schema);

const props = (name) => Object.keys(defs[name]?.properties ?? {}).sort();
const required = (name) => [...(defs[name]?.required ?? [])].sort();
const output = {
  protocolVersion: "codex-cli 0.148.0",
  methods: {
    threadFork: methods.has("thread/fork"),
    threadArchive: methods.has("thread/archive"),
    threadDelete: methods.has("thread/delete"),
    turnInterrupt: methods.has("turn/interrupt"),
  },
  threadFork: {
    experimentalApiRequiredForExactBoundary: true,
    properties: props("ThreadForkParams"),
    required: required("ThreadForkParams"),
    exactBoundaryFields: ["beforeTurnId", "lastTurnId"].filter((x) => props("ThreadForkParams").includes(x)),
  },
  threadArchive: { required: required("ThreadArchiveParams") },
  threadDelete: { required: required("ThreadDeleteParams") },
  turnInterrupt: { required: required("TurnInterruptParams") },
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
