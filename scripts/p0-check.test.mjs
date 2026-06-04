import assert from 'node:assert/strict';
import test from 'node:test';
import { collectP0Checks, formatP0Report, summarizeP0Checks } from './p0-check.mjs';

test('P0 check exposes the required must-do items', async () => {
  const items = await collectP0Checks();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, [
    'live-photo-generation-save-path',
    'ios-lock-screen-preset',
    'local-import-metadata',
    'timeline-trim',
    'manual-keyframe',
    'standard-lock-presets',
    'export-preview-download',
    'save-setting-guidance',
    'privacy-failure-handling',
  ]);
});

test('P0 report is stable and summarized', async () => {
  const items = await collectP0Checks();
  const summary = summarizeP0Checks(items);
  const report = formatP0Report(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive P0 Checklist/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each P0 item has automated implementation and manual evidence checks', async () => {
  const items = await collectP0Checks();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending P0 evidence is not confused with pass marker examples', async () => {
  const items = await collectP0Checks();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
