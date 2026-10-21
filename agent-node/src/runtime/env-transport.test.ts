// #1510 —— 节点怎么连 Hub,决定密钥能不能转发给它。
import { describe, expect, test } from "bun:test";
import { envTransportFor } from "./env-transport.js";

describe("envTransportFor", () => {
  test("a hub on this machine is loopback", () => {
    expect(envTransportFor("http://127.0.0.1:9200")).toBe("loopback");
    expect(envTransportFor("http://127.0.0.53:9200")).toBe("loopback");
    expect(envTransportFor("http://localhost:9200")).toBe("loopback");
    expect(envTransportFor("http://[::1]:9200")).toBe("loopback");
  });

  test("an encrypted hub link is https", () => {
    expect(envTransportFor("https://hub.example.test")).toBe("https");
    expect(envTransportFor("https://127.0.0.1:9200")).toBe("https");
  });

  test("plaintext to another host is plain", () => {
    expect(envTransportFor("http://hub.example.test")).toBe("plain");
    expect(envTransportFor("http://10.249.12.47:9200")).toBe("plain");
  });

  test("an unparsable url is treated as plain (fail closed)", () => {
    expect(envTransportFor("")).toBe("plain");
    expect(envTransportFor("not a url")).toBe("plain");
  });

  test("a non-http scheme is plain", () => {
    expect(envTransportFor("ws://hub.example.test")).toBe("plain");
  });
});
