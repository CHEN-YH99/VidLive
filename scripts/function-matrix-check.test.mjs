import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectFunctionMatrix,
  formatFunctionMatrixReport,
  summarizeFunctionMatrix,
} from './function-matrix-check.mjs';

test('function matrix exposes the required 11.1 categories', async () => {
  const items = await collectFunctionMatrix();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, ['input-format', 'file-size', 'duration', 'aspect-ratio', 'codec', 'export', 'error']);
});

test('function matrix report is stable and summarized', async () => {
  const items = await collectFunctionMatrix();
  const summary = summarizeFunctionMatrix(items);
  const report = formatFunctionMatrixReport(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive Function Test Matrix/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each function matrix category has automated checks and manual evidence checks', async () => {
  const items = await collectFunctionMatrix();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending manual evidence is not confused with pass marker examples', async () => {
  const items = await collectFunctionMatrix();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
