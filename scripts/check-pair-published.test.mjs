// The half-pair guard must fail on the 2026-10-19 shape and pass on a full pair.
import { test, expect } from 'bun:test';
import { checkPair, readPair } from './check-pair-published.mjs';

const tree = 'export const PAIRED_AGENT_NETWORK_VERSION = "2.3.0-preview.186";\n'
  + 'export const PAIRED_AGENT_NODE_VERSION = "2.5.0-preview.150";\n';

test('reads both constants out of the pair module', () => {
  expect(readPair(tree)).toEqual({ network: '2.3.0-preview.186', node: '2.5.0-preview.150' });
  expect(readPair('nothing here')).toBeNull();
});

test('2026-10-19 half pair: node published, CLI only staged', () => {
  const result = checkPair({ network: '2.3.0-preview.186', node: '2.5.0-preview.150' },
    (spec) => spec.includes('agent-node') ? '2.5.0-preview.150' : null);
  expect(result.ok).toBe(false);
  expect(result.problems[0]).toContain('agent-network@2.3.0-preview.186 is not published');
});

test('full pair passes', () => {
  const result = checkPair({ network: '2.3.0-preview.184', node: '2.5.0-preview.148' },
    (spec) => spec.split('@').slice(-1)[0]);
  expect(result.ok).toBe(true);
});
