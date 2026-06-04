import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPrivacyChecks, formatPrivacyReport, summarizePrivacyChecks } from './privacy-check.mjs';

test('privacy check exposes the required 11.3 items', async () => {
  const items = await collectPrivacyChecks();
  const ids = items.map((item) => item.id);

  assert.deepEqual(ids, [
    'local-original-no-upload',
    'local-thumbnail-no-upload',
    'cloud-consent-before-upload',
    'cloud-expiry-auto-delete',
    'manual-delete-invalidates-link',
  ]);
});

test('privacy report is stable and summarized', async () => {
  const items = await collectPrivacyChecks();
  const summary = summarizePrivacyChecks(items);
  const report = formatPrivacyReport(items);

  assert.equal(summary.pass + summary.blocked, items.length);
  assert.match(report, /VidLive Privacy Test/);
  assert.match(report, /Summary: PASS \d+, BLOCKED \d+/);
});

test('each privacy item has automated checks and manual evidence checks', async () => {
  const items = await collectPrivacyChecks();

  for (const item of items) {
    assert.ok(item.autoResults.length > 0);
    assert.ok(item.manualResults.length > 0);
  }
});

test('pending privacy evidence is not confused with pass marker examples', async () => {
  const items = await collectPrivacyChecks();

  assert.ok(items.some((item) => item.status === 'blocked'));
});
