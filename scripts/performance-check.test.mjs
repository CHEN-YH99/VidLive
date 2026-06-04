import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectPerformanceChecks,
  formatPerformanceReport,
  summarizePerformanceChecks,
} from './performance-check.mjs';

test('performance check exposes the required 11.4 metrics', async () => {
  const items = await collectPerformanceChecks();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, [
    'first-interactive',
    'local-parse-100mb',
    'local-convert-10s-1080p',
    'cloud-convert-30s-1080p',
    'export-package',
  ]);
});

test('performance report is stable and summarized', async () => {
  const items = await collectPerformanceChecks();
  const summary = summarizePerformanceChecks(items);
  const report = formatPerformanceReport(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive Performance Test/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each performance metric has automated checks and manual evidence checks', async () => {
  const items = await collectPerformanceChecks();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending performance evidence is not confused with pass marker examples', async () => {
  const items = await collectPerformanceChecks();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
