import { isReservedEnvKey } from './reserved-env';
export const validScopedSecretKey = (key: unknown): key is string => typeof key === 'string'
  && /^[A-Z_][A-Z0-9_]{0,127}$/.test(key) && !isReservedEnvKey(key)
  && !['CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','TMUX','TMUX_PANE','TEMP','TMP'].includes(key)
  && !['COMMHUB_','ANET_','CLAUDE_CODE_'].some(p => key.startsWith(p));
