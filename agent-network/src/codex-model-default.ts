export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export const CODEX_MODEL_CHOICES: ReadonlyArray<{
  readonly id: string;
  readonly default?: boolean;
}> = [
  { id: DEFAULT_CODEX_MODEL, default: true },
  { id: "o3" },
] as const;

export function defaultCodexModelForRuntime(runtime: string): string | undefined {
  return runtime === "codex-sdk" ||
    runtime === "codex-app-server"
    ? DEFAULT_CODEX_MODEL
    : undefined;
}
