/** Packages @opencode/cli 2.0.22 documents for OpenAI-compatible providers.
 * Kept as data so the launcher and the runtime allowlist cannot drift by
 * rewriting the provider into a different shape. */
export const OPENCODE_V2_NATIVE_PACKAGES = Object.freeze([
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses",
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/chat",
  "@opencode/ai/providers/openai/responses",
]);
