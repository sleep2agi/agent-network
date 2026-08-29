import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPTIONAL_TELEMETRY_KEYS,
  isTelemetrySchemaRejection,
  withoutOptionalTelemetry,
} from "./register-telemetry-fallback";

// 实测抓到的那条原文（#1225 复现容器，--network none）。
const REAL = {
  code: -32602,
  message:
    "tool isError: MCP error -32602: Input validation error: Invalid arguments for tool " +
    "report_status: Invalid input: expected string, received null at host.ip",
};

describe("isTelemetrySchemaRejection", () => {
  test("🔴 认得真实抓到的那条 host.ip 拒绝", () => {
    expect(isTelemetrySchemaRejection(REAL)).toBe(true);
  });

  test("三个可选遥测块都算", () => {
    for (const key of OPTIONAL_TELEMETRY_KEYS) {
      expect(isTelemetrySchemaRejection({ code: -32602, message: `bad at ${key}.field` })).toBe(true);
    }
  });

  test("🔴 必需字段被拒**不**兜底 —— 那是本节点自己的 bug，盖住比崩了更糟", () => {
    expect(isTelemetrySchemaRejection({
      code: -32602,
      message: "Invalid input: expected string, received null at alias",
    })).toBe(false);
  });

  test("🔴 只是正文里出现 host 这个词，不算 —— 判据要求带点号的路径", () => {
    expect(isTelemetrySchemaRejection({
      code: -32602, message: "cannot reach host, network unreachable",
    })).toBe(false);
  });

  test("别的错误码一律不兜底（鉴权失败、传输错误都该照常抛）", () => {
    expect(isTelemetrySchemaRejection({ code: 401, message: "unauthorized at host.ip" })).toBe(false);
    expect(isTelemetrySchemaRejection({ code: -32603, message: "internal at host.ip" })).toBe(false);
    expect(isTelemetrySchemaRejection({ message: "no code at host.ip" })).toBe(false);
  });

  test("码是字符串形态的 -32602 也认（JSON 里两种都见过）", () => {
    expect(isTelemetrySchemaRejection({ code: "-32602", message: "x at host.ip" })).toBe(true);
  });

  test("非对象输入不炸", () => {
    for (const v of [null, undefined, "boom", 42]) expect(isTelemetrySchemaRejection(v)).toBe(false);
  });
});

describe("withoutOptionalTelemetry", () => {
  test("只摘掉三个遥测块，别的字段原样保留", () => {
    const params = {
      resume_id: "r", alias: "a", status: "idle",
      host: { ip: null }, process_telemetry: { rss: 1 }, external_schedules: { schedules: [] },
    };
    const out = withoutOptionalTelemetry(params) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["alias", "resume_id", "status"]);
  });

  test("🔴 不改原对象 —— 重试路径不能顺手把调用方的负载改掉", () => {
    const params = { alias: "a", host: { ip: null } };
    withoutOptionalTelemetry(params);
    expect(params.host).toEqual({ ip: null });
  });
});

// 判据本身对了，还要证明它**接在了那条会打死进程的路径上**。
// （"存在 / 挂上 / 真的触发"是三件事。）
describe("register() 的接线", () => {
  const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");

  test("🔴 启动注册用了这个兜底，而不是别处", () => {
    const reg = cli.indexOf("const register = async () => {");
    expect(reg).toBeGreaterThan(-1);
    const end = cli.indexOf("const reportStatus = async (", reg);
    expect(end).toBeGreaterThan(reg);
    const body = cli.slice(reg, end);
    expect(body).toContain("isTelemetrySchemaRejection");
    expect(body).toContain("withoutOptionalTelemetry(payload)");
    // 不认得的错误必须原样抛 —— 否则"注册失败"会退化成一条 warn。
    expect(body).toContain("if (!isTelemetrySchemaRejection(e)) throw e;");
  });

  test("兜底只用一次 —— 重试那次再失败就该抛，不许无限降级", () => {
    const reg = cli.indexOf("const register = async () => {");
    const end = cli.indexOf("const reportStatus = async (", reg);
    const body = cli.slice(reg, end);
    expect(body.split("withoutOptionalTelemetry").length - 1).toBe(1);
  });
});
