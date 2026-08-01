/**
 * Credential redaction for durable state and ordinary logs.
 *
 * This module deliberately has a different contract from child-process env
 * isolation.  Child envs must be built from an exact key allowlist; this is
 * the last-line persistence boundary for text that may contain credentials.
 * Callers should provide every credential value they already know.  Shape and
 * assignment matching then covers common values that arrive inside task text
 * or error strings.
 */

export const CREDENTIAL_REDACTION = "[REDACTED_CREDENTIAL]";

export interface CredentialRedactionOptions {
  /** Exact credential values known to the caller (config, env, credential store). */
  knownValues?: Iterable<string | undefined | null>;
  placeholder?: string;
}

export interface CredentialRedactionResult {
  text: string;
  redactions: number;
}

export interface CredentialRedactor {
  redactText(text: unknown): CredentialRedactionResult;
  redactValue<T>(value: T): T;
}

const DIRECT_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // CommHub credentials.  Eight characters is the same conservative lower
  // bound used by the existing child-env mask and catches legacy atok values.
  /\b(?:ntok|utok|atok)_[A-Za-z0-9_-]{8,}\b/g,
  // GitHub classic and fine-grained credentials.
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Common provider/token forms that can appear without a KEY=value label.
  /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Connection strings with embedded userinfo are credentials even when an
  // upstream error omitted the DATABASE_URL key name.
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:@/]+:[^@\s/]+@[^\s"'<>]+/gi,
];

const SENSITIVE_EXACT_KEYS = new Set([
  "DATABASE_URL",
  "PASSWORD",
  "NTOK",
  "UTOK",
  "ATOK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
]);

/**
 * Whether an assignment key conventionally carries credential material.
 * Merely mentioning these words in prose is not enough; the text redactor
 * only applies this predicate to syntactic key/value assignments.
 */
export function isCredentialKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return SENSITIVE_EXACT_KEYS.has(normalized)
    || /_(?:TOKEN|SECRET|KEY|PASSWORD)$/.test(normalized);
}

/**
 * Collect exact values from a credential-bearing env/config map.  Unknown
 * ordinary keys are ignored unless their value itself has a credential shape.
 * This is intended for constructing the process-wide log/persistence
 * redactor; it must never be used as a substitute for a child env allowlist.
 */
export function collectKnownCredentialValues(
  source: Record<string, string | undefined>,
  extra: Iterable<string | undefined | null> = [],
): string[] {
  const values = new Set<string>();
  for (const value of extra) {
    if (typeof value === "string" && value.length > 0) values.add(value);
  }
  for (const [key, value] of Object.entries(source)) {
    if (!value) continue;
    if (isCredentialKey(key) || containsDirectCredential(value)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function containsDirectCredential(value: string): boolean {
  return DIRECT_CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function replaceMatches(
  input: string,
  pattern: RegExp,
  replacement: string,
): { text: string; count: number } {
  let count = 0;
  pattern.lastIndex = 0;
  const text = input.replace(pattern, () => {
    count++;
    return replacement;
  });
  return { text, count };
}

/** Replace values in JSON/object-inspect and shell-style assignments. */
function redactAssignments(input: string, placeholder: string): CredentialRedactionResult {
  let text = input;
  let redactions = 0;

  // JSON and object-inspect quoted values.  Keeping the quote characters
  // preserves valid JSON where the input was valid JSON.
  const quoted = /(["']?)([A-Za-z_][A-Za-z0-9_]*)(\1\s*[:=]\s*)(["'])((?:\\.|(?!\4)[^\\\r\n])*)\4/g;
  text = text.replace(quoted, (match, keyQuote, key, separator, valueQuote) => {
    if (!isCredentialKey(key)) return match;
    redactions++;
    return `${keyQuote}${key}${separator}${valueQuote}${placeholder}${valueQuote}`;
  });

  // Unquoted env/error values.  Quoted values have already been replaced and
  // the placeholder remains harmless if this pass encounters it again.
  const bare = /\b([A-Za-z_][A-Za-z0-9_]*)\s*([=:])\s*([^\s,;{}]+)/g;
  text = text.replace(bare, (match, key, separator, value) => {
    if (!isCredentialKey(key) || value.includes(placeholder)) return match;
    redactions++;
    return `${key}${separator}${placeholder}`;
  });

  return { text, redactions };
}

export function createCredentialRedactor(
  options: CredentialRedactionOptions = {},
): CredentialRedactor {
  const placeholder = options.placeholder || CREDENTIAL_REDACTION;
  const knownValues = [...new Set(
    [...(options.knownValues ?? [])]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )]
    .filter((value) => value !== placeholder)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  const redactText = (input: unknown): CredentialRedactionResult => {
    if (typeof input !== "string" || input.length === 0) {
      return { text: typeof input === "string" ? input : "", redactions: 0 };
    }

    let text = input;
    let redactions = 0;

    // Exact caller-known values take priority.  String split avoids treating
    // punctuation in a credential as regular-expression syntax.
    for (const value of knownValues) {
      const pieces = text.split(value);
      if (pieces.length === 1) continue;
      redactions += pieces.length - 1;
      text = pieces.join(placeholder);
    }

    for (const pattern of DIRECT_CREDENTIAL_PATTERNS) {
      const result = replaceMatches(text, pattern, placeholder);
      text = result.text;
      redactions += result.count;
    }

    const assigned = redactAssignments(text, placeholder);
    return { text: assigned.text, redactions: redactions + assigned.redactions };
  };

  const redactValue = <T>(value: T): T => {
    const seen = new WeakMap<object, unknown>();
    const visit = (current: unknown, parentKey?: string): unknown => {
      if (typeof current === "string") {
        // Structured config/error objects give us stronger context than free
        // text.  A credential-bearing key is sufficient to redact even a
        // short opaque value that has no recognizable token prefix.
        if (parentKey && isCredentialKey(parentKey) && current !== placeholder) {
          return placeholder;
        }
        return redactText(current).text;
      }
      if (current == null || typeof current !== "object") return current;
      if (seen.has(current)) return seen.get(current);
      if (Array.isArray(current)) {
        const out: unknown[] = [];
        seen.set(current, out);
        for (const item of current) out.push(visit(item));
        return out;
      }
      const out: Record<string, unknown> = {};
      seen.set(current, out);
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        // Keys are retained for schema stability; every string value crosses
        // the same boundary, including identifiers and error metadata.
        out[key] = visit(child, key);
      }
      return out;
    };
    return visit(value) as T;
  };

  return { redactText, redactValue };
}

/** Convenience one-shot API for ordinary log call sites. */
export function redactCredentialText(
  text: unknown,
  options: CredentialRedactionOptions = {},
): CredentialRedactionResult {
  return createCredentialRedactor(options).redactText(text);
}
