/* global Blob, FormData, URLSearchParams, console, fetch, process, setTimeout */
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = path.join(root, 'tmp', 'phase2-smoke');
const uploadDir = path.join(smokeDir, 'uploads');
const inputPath = path.join(smokeDir, 'phase2-smoke.mp4');
const apiPort = Number(process.env.PHASE2_SMOKE_PORT ?? 3132);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

async function main() {
  await rm(smokeDir, { recursive: true, force: true });
  await mkdir(smokeDir, { recursive: true });

  const server = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: apiPort.toString(),
      CLOUD_RETENTION_HOURS: '24',
      LOG_LEVEL: 'error',
      UPLOAD_DIR: uploadDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];

  server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  try {
    await waitForHealth();
    await createSampleVideo();
    await assertCapabilities();

    const job = await createCloudJob();
    const completedJob = await waitForCompletedJob(job.id);
    const zipSize = await downloadZip(completedJob);

    await deleteJob(completedJob.id);

    console.log(`Phase 2 smoke passed: job ${completedJob.id}, zip ${zipSize} bytes`);
  } finally {
    server.kill();
    await waitForExit(server);
    await rm(smokeDir, { recursive: true, force: true });
  }

  if (logs.some((line) => line.includes('EADDRINUSE'))) {
    throw new Error(`API port ${apiPort} is already in use.`);
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      await sleep(500);
    }
  }

  throw new Error('API did not become healthy in time.');
}

async function createSampleVideo() {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=720x1280:rate=30',
    '-t',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    inputPath,
  ]);
}

async function assertCapabilities() {
  const response = await fetch(`${apiBaseUrl}/api/conversions/capabilities`);
  const capabilities = await response.json();

  if (!response.ok || capabilities.beta?.cloudJobsEndpoint !== '/api/conversions/cloud-jobs') {
    throw new Error('Beta cloud capabilities are not exposed.');
  }
}

async function createCloudJob() {
  const file = await readFile(inputPath);
  const formData = new FormData();
  formData.append('file', new Blob([file], { type: 'video/mp4' }), 'phase2-smoke.mp4');

  const query = new URLSearchParams({
    presetId: 'ios-lock-screen',
    aspectRatioId: '9:16',
    fitMode: 'cover',
    startSeconds: '0',
    endSeconds: '2',
    keyframeSeconds: '1',
    muted: 'true',
  });
  const response = await fetch(`${apiBaseUrl}/api/conversions/cloud-jobs?${query.toString()}`, {
    method: 'POST',
    body: formData,
  });
  const body = await response.json();

  if (response.status !== 202 || !body.id) {
    throw new Error(`Cloud job was not accepted: ${response.status}`);
  }

  return body;
}

async function waitForCompletedJob(jobId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${apiBaseUrl}/api/conversions/cloud-jobs/${jobId}`);
    const job = await response.json();

    if (job.status === 'completed') {
      return job;
    }

    if (job.status === 'failed' || job.status === 'expired' || job.status === 'deleted') {
      throw new Error(`Cloud job ended as ${job.status}: ${job.error?.message ?? 'no error message'}`);
    }

    await sleep(1_000);
  }

  throw new Error('Cloud job did not complete in time.');
}

async function downloadZip(job) {
  if (!job.artifact?.downloadUrl) {
    throw new Error('Completed job did not include a download URL.');
  }

  const response = await fetch(`${apiBaseUrl}${job.artifact.downloadUrl}`);
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = await response.arrayBuffer();

  if (!response.ok || !contentType.includes('application/zip') || bytes.byteLength < 100) {
    throw new Error(`Cloud ZIP download failed: ${response.status}, ${contentType}, ${bytes.byteLength} bytes`);
  }

  return bytes.byteLength;
}

async function deleteJob(jobId) {
  const response = await fetch(`${apiBaseUrl}/api/conversions/cloud-jobs/${jobId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(`Cloud job delete failed: ${response.status}`);
  }

  const downloadResponse = await fetch(`${apiBaseUrl}/api/conversions/cloud-jobs/${jobId}/download`);

  if (downloadResponse.status !== 404) {
    throw new Error('Deleted cloud job is still downloadable.');
  }
}

function waitForExit(server) {
  return new Promise((resolve) => {
    server.once('exit', resolve);
    windowlessKillFallback(server);
  });
}

function windowlessKillFallback(server) {
  setTimeout(() => {
    if (!server.killed) {
      server.kill('SIGKILL');
    }
  }, 2_000);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await main();
