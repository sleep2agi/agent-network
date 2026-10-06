// Patch cli.ts the way the #673 review bypassed the static guard.
// The pinned source text stays, so a grep of that text still matches.
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const mode = process.argv[3];
const text = readFileSync(path, "utf8");

function once(hay, needle, replacement, label) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) {
    console.error(`mutate ${label}: anchor count ${n}`);
    process.exit(2);
  }
  return hay.replace(needle, replacement);
}

function commentAbort(hay) {
  const start = hay.indexOf('if (authDecision.action === "abort") {');
  if (start < 0) {
    console.error("mutate comment-abort: abort if missing");
    process.exit(2);
  }
  const open = hay.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let j = open; j < hay.length; j++) {
    if (hay[j] === "{") depth += 1;
    else if (hay[j] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = j + 1;
        break;
      }
    }
  }
  if (end < 0) {
    console.error("mutate comment-abort: brace mismatch");
    process.exit(2);
  }
  const block = hay.slice(start, end);
  if (block.includes("*/")) {
    console.error("mutate comment-abort: block already contains a comment end");
    process.exit(2);
  }
  return hay.slice(0, start) + "/* " + block + " */" + hay.slice(end);
}

let next;
if (mode === "continue-abort") {
  next = once(
    text,
    'const authDecision = claudeAuthRetryDecision(m);\n            if (authDecision.action === "abort") {',
    'const authDecision = claudeAuthRetryDecision(m);\n            continue;\n            if (authDecision.action === "abort") {',
    mode,
  );
} else if (mode === "continue-catch") {
  next = once(
    text,
    'const thrown = claudeThrownErrorDisposition(msg, authAbortedThisAttempt);\n      if (thrown.action === "stop") {',
    'const thrown = claudeThrownErrorDisposition(msg, authAbortedThisAttempt);\n      continue;\n      if (thrown.action === "stop") {',
    mode,
  );
} else if (mode === "comment-abort") {
  next = commentAbort(text);
} else if (mode === "m8") {
  // Gate the abort with false. The words stay; the branch never runs.
  next = once(
    text,
    'if (authDecision.action === "abort") {',
    'if (false && authDecision.action === "abort") {',
    mode,
  );
} else if (mode === "abort-first") {
  // Attempt 1 is the CLI's refresh chance. Aborting there drops a 401
  // that would have been followed by 200.
  next = once(text, "if (attempt >= 2) {", "if (attempt >= 1) {", mode);
} else if (mode === "retry-first") {
  // Review mutation: auth stop waits for the outer retry budget first.
  // Not a default witness. The green call-count assertions are what go red.
  next = once(
    text,
    'if (thrown.action === "stop") {',
    'if (thrown.action === "stop" && attempt >= CLAUDE_MAX_RETRIES) {',
    mode,
  );
} else if (mode === "drop-login-dead") {
  // Review mutation: the abort branch no longer sticks the idle hint.
  next = once(
    text,
    "aborting the attempt`);\n              markClaudeLoginDead();\n",
    "aborting the attempt`);\n",
    mode,
  );
} else {
  console.error(`mutate: unknown mode ${mode}`);
  process.exit(2);
}

if (next === text) {
  console.error(`mutate ${mode}: file unchanged`);
  process.exit(2);
}
writeFileSync(path, next);
console.log(`mutated ${mode}`);
