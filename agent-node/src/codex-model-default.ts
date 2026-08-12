export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

export function resolveCodexModel(explicitModel: string | undefined): string {
  return explicitModel || DEFAULT_CODEX_MODEL;
}
