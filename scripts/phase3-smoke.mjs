/* global console, fetch, process, setTimeout */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = path.join(root, 'tmp', 'phase3-smoke');
const apiPort = Number(process.env.PHASE3_SMOKE_PORT ?? 3133);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

async function main() {
  await rm(smokeDir, { recursive: true, force: true });

  const server = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: apiPort.toString(),
      JWT_SECRET: 'phase3-smoke-secret',
      LOG_LEVEL: 'error',
      UPLOAD_DIR: smokeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth();

    const email = `phase3-${Date.now()}@vidlive.test`;
    const register = await postJson('/api/v1/auth/register', {
      email,
      username: 'phase3-smoke',
      password: 'VidLive-Smoke-2026!',
    });
    assert(register.user?.email === email, 'register did not return user');

    const login = await postJson('/api/v1/auth/login', await createLoginPayload({
      email,
      password: 'VidLive-Smoke-2026!',
    }));
    assert(login.token, 'login did not return token');

    const me = await getJson('/api/v1/me', login.token);
    assert(me.usage?.remainingToday === 5, 'profile usage summary is wrong');

    for (let index = 0; index < 5; index += 1) {
      await postJson('/api/v1/usage/conversions', {}, login.token);
    }

    const quotaExceeded = await fetch(`${apiBaseUrl}/api/v1/usage/conversions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${login.token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert(quotaExceeded.status === 429, 'quota did not block the sixth conversion');

    const keyframes = await postJson('/api/v1/keyframes/recommendations', {
      durationSeconds: 6,
      width: 720,
      height: 1280,
      hasAudio: true,
    });
    assert(keyframes.recommendations?.length === 3, 'keyframe recommendations missing');

    await postJson('/api/v1/compatibility-feedback', {
      presetId: 'ios-lock-screen',
      device: 'iPhone smoke',
      iosVersion: '18',
      savedToPhotos: true,
      lockScreenPlayed: true,
    }, login.token);

    const compatibility = await getJson('/api/v1/compatibility-feedback/summary');
    assert(compatibility.total === 1, 'compatibility feedback summary did not update');

    const metrics = await getJson('/api/v1/metrics/summary');
    assert(metrics.users === 1, 'metrics summary did not count users');

    const readiness = await getJson('/api/v1/launch-readiness');
    assert(Array.isArray(readiness.checks), 'launch readiness checks missing');

    console.log(`Phase 3 smoke passed: user ${register.user.id}`);
  } finally {
    server.kill();
    await waitForExit(server);
    await rm(smokeDir, { recursive: true, force: true });
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

async function postJson(route, body, token) {
  const response = await fetch(`${apiBaseUrl}${route}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function getJson(route, token) {
  const response = await fetch(`${apiBaseUrl}${route}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function createLoginPayload(body) {
  const challenge = await getJson('/api/v1/auth/challenge');

  return {
    ...body,
    challengeId: challenge.id,
    challengeAnswer: solveChallenge(challenge),
  };
}

function solveChallenge(challenge) {
  for (let answer = 0; answer <= 10_000_000; answer += 1) {
    const value = answer.toString();
    const digest = createHash('sha256').update(`${challenge.id}:${challenge.nonce}:${value}`).digest('hex');

    if (digest.startsWith(challenge.prefix)) {
      return value;
    }
  }

  throw new Error('Failed to solve auth challenge.');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function waitForExit(server) {
  return new Promise((resolve) => {
    server.once('exit', resolve);
    setTimeout(() => {
      if (!server.killed) {
        server.kill('SIGKILL');
      }
    }, 2_000);
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await main();
