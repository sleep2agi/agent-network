import { expect, test } from "bun:test";
import { classifyHubTransport } from "./env-transport.js";

test("loopback forms", () => {
  expect(classifyHubTransport("http://127.0.0.1:9200")).toBe("loopback");
  expect(classifyHubTransport("http://127.8.9.10:9200")).toBe("loopback");
  expect(classifyHubTransport("http://localhost:9200")).toBe("loopback");
  expect(classifyHubTransport("http://[::1]:9200")).toBe("loopback");
});

test("TLS forms", () => {
  expect(classifyHubTransport("https://hub.example.com")).toBe("https");
  expect(classifyHubTransport("wss://hub.example.com/mcp")).toBe("https");
  expect(classifyHubTransport("https://127.0.0.1:9200")).toBe("loopback"); // loopback wins
});

test("anything else is plain — an unparseable URL is never 'safe'", () => {
  expect(classifyHubTransport("http://10.249.12.47:9200")).toBe("plain");
  expect(classifyHubTransport("ws://hub.example.com")).toBe("plain");
  expect(classifyHubTransport("hub.example.com")).toBe("plain");
  expect(classifyHubTransport("")).toBe("plain");
  expect(classifyHubTransport(undefined)).toBe("plain");
});
