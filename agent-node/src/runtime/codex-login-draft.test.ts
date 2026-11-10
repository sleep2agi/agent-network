import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexLoginEnvironment, createCodexLoginDraft } from './codex-login-draft';

test('login child drops inherited accounts, API keys and runtime injection options', () => {
  const env = codexLoginEnvironment('/private/draft', {
    PATH: '/usr/bin', HOME: '/other', CODEX_HOME: '/other/account', OPENAI_API_KEY: 'TEST-ONLY',
    CODEX_ACCESS_TOKEN: 'TEST-ONLY', DEEPSEEK_API_KEY: 'TEST-ONLY', NODE_OPTIONS: '--inspect',
    HTTPS_PROXY: 'http://proxy.invalid:8080',
  });
  expect(env.PATH).toBe('/usr/bin');
  expect(env.HTTPS_PROXY).toBe('http://proxy.invalid:8080');
  expect(env.HOME).toBe('/private/draft');
  expect(env.CODEX_HOME).toBe('/private/draft');
  expect(JSON.stringify(env)).not.toMatch(/TEST-ONLY|--inspect|\/other/);
});

test('unsafe/symlinked root is refused without changing existing account files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anet-login-root-'));
  try {
    const other = join(root, 'other'); mkdirSync(other, { mode: 0o700 });
    const link = join(root, 'linked'); symlinkSync(other, link);
    await expect(createCodexLoginDraft(link)).rejects.toThrow('unsafe_login_root');
    expect(readdirSync(other)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing executable leaves no abandoned draft and returns no raw process details', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anet-login-failure-'));
  try {
    await expect(createCodexLoginDraft(root, '/definitely-missing-codex')).rejects.toThrow('login_process_start_failed');
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
