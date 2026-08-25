import fs from "node:fs";
import path from "node:path";

const [normalDir, experimentalDir] = process.argv.slice(2);
const read = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
const normalRequest = read(normalDir, "ClientRequest.json");
const expRequest = read(experimentalDir, "ClientRequest.json");
const expNotification = read(experimentalDir, "ServerNotification.json");
const expForkResponse = read(experimentalDir, "v2/ThreadForkResponse.json");
const expReadResponse = read(experimentalDir, "v2/ThreadReadResponse.json");
const props = (schema, name) => Object.keys(schema.definitions?.[name]?.properties ?? {}).sort();
const required = (schema, name) => [...(schema.definitions?.[name]?.required ?? [])].sort();
const has = (schema, name, property) => props(schema, name).includes(property);
const rootProps = (schema) => Object.keys(schema.properties ?? {}).sort();
const rootRequired = (schema) => [...(schema.required ?? [])].sort();

const output = {
  artifact: { codexCli: "0.148.0", schemaMode: "normal+experimental" },
  forkBoundary: {
    lastTurnId: { normalSchema: has(normalRequest, "ThreadForkParams", "lastTurnId"), experimentalSchema: has(expRequest, "ThreadForkParams", "lastTurnId"), requiresExperimental: false },
    beforeTurnId: { normalSchema: has(normalRequest, "ThreadForkParams", "beforeTurnId"), experimentalSchema: has(expRequest, "ThreadForkParams", "beforeTurnId"), requiresExperimental: true },
    requestRequired: required(expRequest, "ThreadForkParams"),
  },
  initialize: {
    capabilitiesProperties: props(expRequest, "InitializeCapabilities"),
    experimentalApiDefault: expRequest.definitions.InitializeCapabilities.properties.experimentalApi.default,
  },
  responseShape: {
    threadFork: { properties: rootProps(expForkResponse), required: rootRequired(expForkResponse) },
    threadRead: { properties: rootProps(expReadResponse), required: rootRequired(expReadResponse) },
  },
  ownershipShape: {
    thread: { properties: props(expNotification, "Thread"), required: required(expNotification, "Thread") },
    turn: { properties: props(expNotification, "Turn"), required: required(expNotification, "Turn") },
    turnStarted: { properties: props(expNotification, "TurnStartedNotification"), required: required(expNotification, "TurnStartedNotification") },
    turnCompleted: { properties: props(expNotification, "TurnCompletedNotification"), required: required(expNotification, "TurnCompletedNotification") },
  },
};
if (!output.forkBoundary.lastTurnId.normalSchema || output.forkBoundary.beforeTurnId.normalSchema) throw new Error("normal/experimental boundary classification drifted");
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
