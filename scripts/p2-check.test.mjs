import assert from 'node:assert/strict';
import test from 'node:test';
import { collectP2Checks, formatP2Report, summarizeP2Checks } from './p2-check.mjs';

test('P2 check exposes the required after-V1 items', async () => {
  const items = await collectP2Checks();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, [
    'user-system',
    'quota-history',
    'ai-keyframe',
    'webp-export',
    'paid-subscription',
    'batch-processing',
    'four-k-output',
  ]);
});

test('P2 report is stable and summarized', async () => {
  const items = await collectP2Checks();
  const summary = summarizeP2Checks(items);
  const report = formatP2Report(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive P2 Checklist/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each P2 item has automated implementation and manual evidence checks', async () => {
  const items = await collectP2Checks();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending P2 evidence is not confused with pass marker examples', async () => {
  const items = await collectP2Checks();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
