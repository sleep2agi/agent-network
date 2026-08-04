import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_REDACTION,
  collectKnownCredentialValues,
  createCredentialRedactor,
  isCredentialKey,
  redactCredentialText,
} from "./credential-redaction";

const KNOWN_DATABASE_URL = "postgresql://preview_user:p4ss-WITH.symbols@db.internal:5432/runtime";
const KNOWN_OPAQUE = "opaque-real-value-without-a-recognizable-prefix-7QX9";

describe("credential persistence redactor", () => {
  test("removes exact caller-known values regardless of punctuation or context", () => {
    const redactor = createCredentialRedactor({
      knownValues: [KNOWN_DATABASE_URL, KNOWN_OPAQUE, KNOWN_DATABASE_URL],
    });
    const source = `failed (${KNOWN_OPAQUE}); url=${KNOWN_DATABASE_URL}; retry ${KNOWN_OPAQUE}`;
    const result = redactor.redactText(source);

    expect(result.redactions).toBe(3);
    expect(result.text).not.toContain(KNOWN_DATABASE_URL);
    expect(result.text).not.toContain(KNOWN_OPAQUE);
    expect(result.text.match(/\[REDACTED_CREDENTIAL\]/g)).toHaveLength(3);
  });

  test("redacts network, GitHub, AWS and provider token shapes in free text", () => {
    const values = [
      "ntok_1234567890abcdef",
      "utok_1234567890abcdef",
      "atok_1234567890abcdef",
      "ghp_123456789012345678901234567890123456",
      "github_pat_1234567890_ABCDEFGHIJKL",
      "AKIA1234567890ABCDEF",
      "sk-1234567890abcdef1234567890abcdef",
    ];
    const result = redactCredentialText(`error carried ${values.join(" | ")}`);

    for (const value of values) expect(result.text).not.toContain(value);
    expect(result.redactions).toBe(values.length);
  });

  test("redacts credential assignments while preserving keys and valid JSON", () => {
    const source = JSON.stringify({
      DATABASE_URL: KNOWN_DATABASE_URL,
      AWS_SECRET_ACCESS_KEY: "aws-secret-material",
      AWS_SESSION_TOKEN: "aws-session-material",
      GITHUB_TOKEN: "github-material",
      SERVICE_TOKEN: "service-material",
      CLIENT_SECRET: "client-material",
      API_KEY: "api-material",
      SERVICE_PASSWORD: "password-material",
      ntok: "opaque-node-token",
      utok: "opaque-user-token",
      AWS_REGION: "us-east-1",
      ordinary: "keep this sentence",
    });
    const result = redactCredentialText(source);
    const parsed = JSON.parse(result.text);

    for (const key of [
      "DATABASE_URL",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GITHUB_TOKEN",
      "SERVICE_TOKEN",
      "CLIENT_SECRET",
      "API_KEY",
      "SERVICE_PASSWORD",
      "ntok",
      "utok",
    ]) {
      expect(parsed[key]).toBe(CREDENTIAL_REDACTION);
    }
    expect(parsed.AWS_REGION).toBe("us-east-1");
    expect(parsed.ordinary).toBe("keep this sentence");
  });

  test("redacts shell/error assignment forms including quoted values", () => {
    const source = [
      "DATABASE_URL=postgres://alice:pw@db/runtime",
      "AWS_SECRET_ACCESS_KEY='secret with spaces'",
      'GITHUB_TOKEN="github token with spaces"',
      "CUSTOM_TOKEN:token-material",
    ].join("; ");
    const result = redactCredentialText(source).text;

    expect(result).toContain(`DATABASE_URL=${CREDENTIAL_REDACTION}`);
    expect(result).toContain(`AWS_SECRET_ACCESS_KEY='${CREDENTIAL_REDACTION}'`);
    expect(result).toContain(`GITHUB_TOKEN="${CREDENTIAL_REDACTION}"`);
    expect(result).toContain(`CUSTOM_TOKEN:${CREDENTIAL_REDACTION}`);
    expect(result).not.toContain("alice:pw");
    expect(result).not.toContain("secret with spaces");
    expect(result).not.toContain("github token with spaces");
  });

  test("redacts an unlabelled connection URI with embedded userinfo", () => {
    const raw = "redis://runtime-user:runtime-password@127.0.0.1:6379/0";
    const result = redactCredentialText(`connect failed for ${raw}`).text;
    expect(result).not.toContain(raw);
    expect(result).toContain(CREDENTIAL_REDACTION);
  });

  test("does not over-delete normal prose and non-credential settings", () => {
    const normal = [
      "token budget is 8192",
      "the secret sauce is documentation",
      "press the keyboard key",
      "AWS_REGION=us-east-1",
      "DATABASE_URL is the documented variable name",
      "ntok_demo is an example prefix, not a credential",
      "monkey=value",
    ].join("; ");
    const result = redactCredentialText(normal);
    expect(result.text).toBe(normal);
    expect(result.redactions).toBe(0);
  });

  test("deep-redacts JSON-like values without mutating the input", () => {
    const input = {
      text: `reply ${KNOWN_OPAQUE}`,
      SERVICE_TOKEN: "short-opaque",
      nested: [
        { error: "DATABASE_URL=postgres://u:p@host/db" },
        { AWS_SECRET_ACCESS_KEY: "otherwise-unrecognizable" },
        "ntok_1234567890abcdef",
      ],
      count: 2,
    };
    const redactor = createCredentialRedactor({ knownValues: [KNOWN_OPAQUE] });
    const output = redactor.redactValue(input);

    expect(output).not.toBe(input);
    expect(output.nested).not.toBe(input.nested);
    expect(JSON.stringify(output)).not.toContain(KNOWN_OPAQUE);
    expect(JSON.stringify(output)).not.toContain("postgres://u:p@host/db");
    expect(JSON.stringify(output)).not.toContain("ntok_1234567890abcdef");
    expect(output.SERVICE_TOKEN).toBe(CREDENTIAL_REDACTION);
    expect(output.nested[1]).toEqual({ AWS_SECRET_ACCESS_KEY: CREDENTIAL_REDACTION });
    expect(input.text).toContain(KNOWN_OPAQUE);
    expect(output.count).toBe(2);
  });
});

describe("credential value collection", () => {
  test("collects exact sensitive values and shaped values under unknown keys", () => {
    const result = collectKnownCredentialValues(
      {
        DATABASE_URL: KNOWN_DATABASE_URL,
        AWS_SECRET_ACCESS_KEY: "aws-material",
        GITHUB_TOKEN: "github-material",
        CUSTOM_SECRET: "custom-material",
        OPAQUE_NAME: "ntok_1234567890abcdef",
        AWS_REGION: "us-east-1",
        NORMAL: "ordinary",
      },
      [KNOWN_OPAQUE, undefined, ""],
    );

    expect(result).toEqual(expect.arrayContaining([
      KNOWN_DATABASE_URL,
      "aws-material",
      "github-material",
      "custom-material",
      "ntok_1234567890abcdef",
      KNOWN_OPAQUE,
    ]));
    expect(result).not.toContain("us-east-1");
    expect(result).not.toContain("ordinary");
  });

  test("key classifier is exact enough not to treat ordinary AWS settings as credentials", () => {
    expect(isCredentialKey("DATABASE_URL")).toBe(true);
    expect(isCredentialKey("service_token")).toBe(true);
    expect(isCredentialKey("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isCredentialKey("service_password")).toBe(true);
    expect(isCredentialKey("ntok")).toBe(true);
    expect(isCredentialKey("utok")).toBe(true);
    expect(isCredentialKey("AWS_REGION")).toBe(false);
    expect(isCredentialKey("monkey")).toBe(false);
  });
});
