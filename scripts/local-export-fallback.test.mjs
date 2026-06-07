/* global process */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const localExportPath = path.join(root, 'apps', 'web', 'lib', 'local-export.ts');

test('local export keeps a source video fallback when browser recording fails', async () => {
  const source = await readFile(localExportPath, 'utf8');

  assert.match(source, /try\s*{\s*const clipBlob = await recordVideoClip/s);
  assert.match(source, /catch\s*{/);
  assert.match(source, /id:\s*'source-video'/);
  assert.match(source, /kind:\s*'source'/);
  assert.match(source, /原始视频备份/);
  assert.match(source, /浏览器本地录制动态片段失败/);
});

test('source video fallback preserves mp4 and mov extensions', async () => {
  const source = await readFile(localExportPath, 'utf8');

  assert.match(source, /function getSourceExtension\(file: File\): '\.mp4' \| '\.mov'/);
  assert.match(source, /extension === '\.mov'/);
  assert.match(source, /return '\.mov'/);
  assert.match(source, /return '\.mp4'/);
  assert.match(source, /video\/quicktime/);
  assert.match(source, /video\/mp4/);
});
