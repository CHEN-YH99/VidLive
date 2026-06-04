import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMilestones, formatMilestoneReport } from './milestones-check.mjs';

test('milestone check exposes M0 through M6', async () => {
  const items = await collectMilestones();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
});

test('milestone report includes pass and blocked summary', async () => {
  const items = await collectMilestones();
  const report = formatMilestoneReport(items);

  assert.match(report, /VidLive Milestones/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});
