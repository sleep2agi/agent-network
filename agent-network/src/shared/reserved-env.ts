// RFC-026 v4 §4.4.7 B1 — reserved env-key denylist (single source of
// truth for hub + daemon).
//
// Scope: env_refs naming a system/process-model sensitive key (PATH /
// LD_PRELOAD / NODE_OPTIONS / BUN_* / NPM_* / ...) MUST be rejected
// before the secret value ever reaches fork(), because such a key in
// the child env is effectively arbitrary code execution.
//
// G9 (drift guard): this module is the ONE source. Daemon-side runtime
// imports the same constants. A divergence between hub and daemon would
// let attacker target the looser layer; CI test asserts set equality.

export const RESERVED_ENV_KEYS_EXACT = new Set<string>([
  "PATH", "HOME", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME",
  "NODE_OPTIONS", "IFS", "PS1", "PS4", "ENV", "BASH_ENV",
  "CDPATH", "PROMPT_COMMAND", "TMPDIR",
]);

// Prefix-match denied. Order matters only for clarity (LD_ catches
// LD_PRELOAD / LD_LIBRARY_PATH / LD_AUDIT; DYLD_ catches DYLD_INSERT_
// LIBRARIES; BUN_ / NPM_ / NPM_CONFIG_ / NODE_ catch ecosystem-level
// runtime config).
export const RESERVED_ENV_PREFIXES: ReadonlyArray<string> = [
  "LD_", "DYLD_", "BUN_", "NPM_", "NPM_CONFIG_", "NODE_",
];

export function isReservedEnvKey(k: string): boolean {
  if (RESERVED_ENV_KEYS_EXACT.has(k)) return true;
  for (const p of RESERVED_ENV_PREFIXES) if (k.startsWith(p)) return true;
  return false;
}
