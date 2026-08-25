import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_INBOX_RECONCILE_MS,
  resolveInboxReconcileMs,
} from './inbox-reconcile';

describe('CommHub inbox reconciliation', () => {
  test('uses a bounded default and rejects unsafe intervals', () => {
    expect(resolveInboxReconcileMs(undefined)).toBe(DEFAULT_INBOX_RECONCILE_MS);
    expect(resolveInboxReconcileMs('')).toBe(DEFAULT_INBOX_RECONCILE_MS);
    expect(resolveInboxReconcileMs('999')).toBe(DEFAULT_INBOX_RECONCILE_MS);
    expect(resolveInboxReconcileMs('wat')).toBe(DEFAULT_INBOX_RECONCILE_MS);
    expect(resolveInboxReconcileMs('2500')).toBe(2500);
  });

  test('the node periodically schedules both durable inbox lanes', () => {
    const cli = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
    const timer = cli.match(/setInterval\(\(\) => \{\s*scheduleWorkInboxDrain\(\);\s*scheduleInformationalInboxDrain\(\);\s*\}, inboxReconcileMs\);/s);
    expect(timer).not.toBeNull();
  });

  test('polling reuses the same coalescing lanes as SSE', () => {
    const cli = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
    expect(cli.match(/scheduleWorkInboxDrain\(\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(cli).toContain('createInboxDrainLane');
  });
});
