import { lstatSync, readFileSync } from "node:fs";

export const MOCK_LLM_FALLBACK = "(mock LLM: no rule matched)";
const MAX_RULES_BYTES = 1024 * 1024;

export type MockLlmRule = Readonly<{
  in_substring: string;
  out: string;
}>;

export type MockLlmResolution = Readonly<{
  reply: string;
  matched: boolean;
  ruleIndex: number | null;
}>;

function fail(message: string): never {
  throw new Error(`[mock-llm] ${message}`);
}

// JSON.parse accepts duplicate object keys and silently keeps the last one.
// Enumerate the top-level keys first so a fixture cannot hide an earlier rule
// value behind a duplicate key. The caller invokes this only after JSON.parse
// has established that `line` is valid JSON.
function topLevelObjectKeys(line: string): string[] {
  const keys: string[] = [];
  let index = 1;
  const skipWhitespace = () => {
    while (/\s/.test(line[index] ?? "")) index += 1;
  };
  const scanString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < line.length) {
      const char = line[index];
      index += 1;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') return line.slice(start, index);
    }
    fail("unterminated JSON string");
  };

  while (index < line.length) {
    skipWhitespace();
    if (line[index] === "}") break;
    if (line[index] !== '"') fail("rule keys must be JSON strings");
    keys.push(JSON.parse(scanString()));
    skipWhitespace();
    if (line[index] !== ":") fail("expected colon after rule key");
    index += 1;

    let depth = 0;
    let inString = false;
    let escaped = false;
    while (index < line.length) {
      const char = line[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        if (depth === 0 && char === "}") break;
        depth -= 1;
      } else if (char === "," && depth === 0) break;
      index += 1;
    }
    if (line[index] === ",") {
      index += 1;
      continue;
    }
    if (line[index] === "}") break;
  }
  return keys;
}

export function loadMockLlmRules(path: string): readonly MockLlmRule[] {
  if (!path) fail("MOCK_LLM_REPLIES_FILE is required");

  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("rules path must be a regular, non-symlink file");
  if (stat.size > MAX_RULES_BYTES) fail(`rules file exceeds ${MAX_RULES_BYTES} bytes`);

  const rules: MockLlmRule[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(`invalid JSON on line ${index + 1}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`line ${index + 1} must be a JSON object`);
    }

    const keys = topLevelObjectKeys(line).sort();
    if (keys.length !== 2 || keys[0] !== "in_substring" || keys[1] !== "out") {
      fail(`line ${index + 1} must contain exactly one in_substring and one out`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.in_substring !== "string" || record.in_substring.length === 0) {
      fail(`line ${index + 1} in_substring must be a non-empty string`);
    }
    if (typeof record.out !== "string" || record.out.length === 0) {
      fail(`line ${index + 1} out must be a non-empty string`);
    }
    rules.push({ in_substring: record.in_substring, out: record.out });
  }

  if (rules.length === 0) fail("rules file contains no rules");
  return Object.freeze(rules);
}

export function resolveMockLlmReply(
  rules: readonly MockLlmRule[],
  prompt: string,
  warn: (message: string) => void = console.error,
): MockLlmResolution {
  const ruleIndex = rules.findIndex((rule) => prompt.includes(rule.in_substring));
  if (ruleIndex < 0) {
    warn(`[mock-llm] warning: no rule matched prompt (${prompt.length} chars)`);
    return { reply: MOCK_LLM_FALLBACK, matched: false, ruleIndex: null };
  }
  return { reply: rules[ruleIndex].out, matched: true, ruleIndex };
}
