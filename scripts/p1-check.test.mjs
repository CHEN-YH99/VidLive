import assert from 'node:assert/strict';
import test from 'node:test';
import { collectP1Checks, formatP1Report, summarizeP1Checks } from './p1-check.mjs';

test('P1 check exposes the required soon-after-MVP items', async () => {
  const items = await collectP1Checks();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, [
    'cloud-processing-fallback',
    'fastify-upload-convert-status-api',
    'redis-bullmq-worker',
    'r2-temporary-links',
    'rotate-flip-background-fill',
    'qr-send-to-phone',
    'basic-monitoring-logs',
  ]);
});

test('P1 report is stable and summarized', async () => {
  const items = await collectP1Checks();
  const summary = summarizeP1Checks(items);
  const report = formatP1Report(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive P1 Checklist/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each P1 item has automated implementation and manual evidence checks', async () => {
  const items = await collectP1Checks();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending P1 evidence is not confused with pass marker examples', async () => {
  const items = await collectP1Checks();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
