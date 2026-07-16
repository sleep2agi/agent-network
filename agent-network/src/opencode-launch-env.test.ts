import { describe, expect, test } from "bun:test";
import {
  hardenOpencodeAgentNodeEnv,
  OPENCODE_AGENT_NODE_LOADER_ENV_KEYS,
} from "./opencode-launch-env";

describe("hardenOpencodeAgentNodeEnv", () => {
  test("restores launcher PATH and strips every pre-entrypoint loader hook", () => {
    const hostile: NodeJS.ProcessEnv = {
      PATH: "/profile/hostile",
      LANG: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      NODE_EXTRA_CA_CERTS: "/operator/ca.pem",
    };
    for (const key of OPENCODE_AGENT_NODE_LOADER_ENV_KEYS) {
      hostile[key] = `/profile/${key.toLowerCase()}`;
    }

    const env = hardenOpencodeAgentNodeEnv(hostile, "/launcher/bin:/usr/bin");
    expect(env.PATH).toBe("/launcher/bin:/usr/bin");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.HTTPS_PROXY).toBe("http://proxy.invalid:8080");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/operator/ca.pem");
    for (const key of OPENCODE_AGENT_NODE_LOADER_ENV_KEYS) {
      expect(env[key], key).toBeUndefined();
    }
  });

  test("does not mutate the caller's env object", () => {
    const source = { PATH: "/profile", NODE_OPTIONS: "--require=/tmp/pwn.cjs" };
    const env = hardenOpencodeAgentNodeEnv(source, "/trusted");
    expect(source).toEqual({ PATH: "/profile", NODE_OPTIONS: "--require=/tmp/pwn.cjs" });
    expect(env).toEqual({ PATH: "/trusted" });
  });

  test("strips case-variant loader and PATH keys for Windows semantics", () => {
    const env = hardenOpencodeAgentNodeEnv({
      Path: "C:\\hostile",
      node_options: "--require=C:\\hostile.cjs",
      Bun_Preload: "C:\\hostile.ts",
      LANG: "en_US.UTF-8",
    }, "C:\\Program Files\\nodejs");
    expect(env.Path).toBeUndefined();
    expect(env.node_options).toBeUndefined();
    expect(env.Bun_Preload).toBeUndefined();
    expect(env.PATH).toBe("C:\\Program Files\\nodejs");
    expect(env.LANG).toBe("en_US.UTF-8");
  });
});
