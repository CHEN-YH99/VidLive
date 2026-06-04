import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPhaseGates, formatGateReport, summarizeGates } from './phase-gates.mjs';

test('phase gates expose the required Phase 0 and Phase 1 checks', async () => {
  const gates = await collectPhaseGates();
  const ids = new Set(gates.map((gate) => gate.id));

  assert.ok(ids.has('phase0.ffmpeg'));
  assert.ok(ids.has('phase0.ffprobe'));
  assert.ok(ids.has('phase0.exiftool'));
  assert.ok(ids.has('phase0.api'));
  assert.ok(ids.has('phase0.manual-evidence'));
  assert.ok(ids.has('phase2.cloud-api'));
  assert.ok(ids.has('phase1.local-export'));
  assert.ok(ids.has('phase1.local-privacy-static'));
  assert.ok(ids.has('phase2.cloud-ui'));
  assert.ok(ids.has('phase1.manual-evidence'));
  assert.ok(ids.has('phase2.manual-evidence'));
});

test('phase gate report is stable and summarized', async () => {
  const gates = await collectPhaseGates();
  const summary = summarizeGates(gates);
  const report = formatGateReport(gates);

  assert.equal(summary.pass + summary.warn + summary.blocked, gates.length);
  assert.match(report, /VidLive Phase Gate/);
  assert.match(report, /Summary: PASS \d+, WARN \d+, BLOCKED \d+/);
});

test('pending manual evidence is not confused with pass examples', async () => {
  const gates = await collectPhaseGates();
  const phase1ManualGate = gates.find((gate) => gate.id === 'phase1.manual-evidence');

  assert.equal(phase1ManualGate?.status, 'blocked');
});
