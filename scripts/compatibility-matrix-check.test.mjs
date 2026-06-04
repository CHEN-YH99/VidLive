import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectCompatibilityMatrix,
  formatCompatibilityMatrixReport,
  summarizeCompatibilityMatrix,
} from './compatibility-matrix-check.mjs';

test('compatibility matrix exposes the required 11.2 platforms', async () => {
  const items = await collectCompatibilityMatrix();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, ['iphone-safari', 'macos-safari', 'chrome-desktop', 'edge-desktop', 'ios17-device']);
});

test('compatibility matrix report is stable and summarized', async () => {
  const items = await collectCompatibilityMatrix();
  const summary = summarizeCompatibilityMatrix(items);
  const report = formatCompatibilityMatrixReport(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive Compatibility Test Matrix/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each compatibility platform has automated checks and manual evidence checks', async () => {
  const items = await collectCompatibilityMatrix();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending compatibility evidence is not confused with pass marker examples', async () => {
  const items = await collectCompatibilityMatrix();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
