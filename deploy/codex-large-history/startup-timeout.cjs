'use strict';
// Compatibility for deployed anet versions with a fixed 15s recovery deadline.
// This is scoped to the launcher; no runtime child inherits the preload.
if (process.env.ANET_CODEX_LARGE_HISTORY_LAUNCH === '1') {
  const original = global.setTimeout;
  delete process.env.NODE_OPTIONS;
  delete process.env.ANET_CODEX_LARGE_HISTORY_LAUNCH;
  global.setTimeout = function (callback, delay, ...args) {
    return original(callback, delay === 15000 ? 120000 : delay, ...args);
  };
}
