export type ParsedCliOptions = {
  [key: string]: string | string[];
  _channels: string[];
  _envs: string[];
};

// Presence-only flags. These must never consume the following positional
// operand as a value. Keep this exact list shared by option and positional
// parsing so the two views of argv cannot drift.
export const BOOLEAN_FLAGS = new Set([
  "--accept-dev-channels",
  "--all",
  "--copresence",
  "--dangerously-allow-full-access",
  "--dev-open",
  "--dry-run",
  "--f",
  "--follow",
  "--grok-headless",
  "--new-session",
  "--no-auto-self",
  "--no-yolo",
  "--resume-latest",
  "--self",
  "--tmux",
  "--yes-danger-full-access",
]);

export function parseCliOptions(argv: string[]): ParsedCliOptions {
  const result: ParsedCliOptions = { _channels: [], _envs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--channel" && argv[i + 1]) {
      result._channels.push(argv[++i]);
      continue;
    }
    if (argv[i] === "--env" && argv[i + 1]) {
      result._envs.push(argv[++i]);
      continue;
    }
    if (BOOLEAN_FLAGS.has(argv[i])) {
      result[argv[i].slice(2)] = "true";
      continue;
    }
    if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      result[argv[i].slice(2)] = argv[++i];
    } else if (argv[i].startsWith("--")) {
      result[argv[i].slice(2)] = "true";
    }
  }
  return result;
}

export function positionalArgs(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--channel" || arg === "--env") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!BOOLEAN_FLAGS.has(arg) && argv[i + 1] && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}
