import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRiskRegister,
  formatRiskRegisterReport,
  summarizeRiskRegister,
} from './risk-register-check.mjs';

test('risk register exposes the required section 12 risks', async () => {
  const items = await collectRiskRegister();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, [
    'live-photo-save-path',
    'lock-screen-rule-opaque',
    'local-transcode-performance',
    'cloud-architecture-overweight',
    'metadata-instability',
    'mobile-timeline-usability',
    'cloud-cost-overrun',
    'ai-keyframe-value',
  ]);
});

test('risk register report is stable and summarized', async () => {
  const items = await collectRiskRegister();
  const summary = summarizeRiskRegister(items);
  const report = formatRiskRegisterReport(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive Risk Register/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each risk has automated mitigations and closure evidence checks', async () => {
  const items = await collectRiskRegister();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending risk evidence is not confused with pass marker examples', async () => {
  const items = await collectRiskRegister();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
