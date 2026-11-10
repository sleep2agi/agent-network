import { describe, expect, test } from "bun:test";
import { isSecureSourceHubUrl } from "./source-hub-url";

describe("isSecureSourceHubUrl", () => {
  test("https and loopback http are accepted", () => {
    for (const u of ["https://y.vansin.top", "https://hub.example.com/", "http://127.0.0.1:9200", "http://localhost:9300", "http://[::1]:9200"]) {
      expect(isSecureSourceHubUrl(u)).toBe(true);
    }
  });
  test("plain http to a remote host is refused (the common prod misconfig)", () => {
    expect(isSecureSourceHubUrl("http://y.vansin.top:9300")).toBe(false);
    expect(isSecureSourceHubUrl("http://10.0.0.5:9200")).toBe(false);
  });
  test("credentials, query, path, hash or garbage are refused", () => {
    for (const u of ["https://u:p@hub.example.com", "https://hub.example.com/?x=1", "https://hub.example.com/api", "https://hub.example.com/#a", "not a url", ""]) {
      expect(isSecureSourceHubUrl(u)).toBe(false);
    }
  });
});
