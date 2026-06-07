/* global console, fetch, process, setTimeout */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = path.join(root, 'tmp', 'phase4-smoke');
const apiPort = Number(process.env.PHASE4_SMOKE_PORT ?? 3134);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

async function main() {
  await rm(smokeDir, { recursive: true, force: true });

  const server = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: apiPort.toString(),
      JWT_SECRET: 'phase4-smoke-secret',
      LOG_LEVEL: 'error',
      UPLOAD_DIR: smokeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth();

    const email = `phase4-${Date.now()}@vidlive.test`;
    const register = await postJson('/api/v1/auth/register', {
      email,
      username: 'phase4-smoke',
      password: 'VidLive-Smoke-2026!',
    });
    assert(register.user?.email === email, 'register did not return user');
    const login = await postJson('/api/v1/auth/login', await createLoginPayload({
      email,
      password: 'VidLive-Smoke-2026!',
    }));
    const token = login.token;
    assert(token, 'login did not return token');

    const plans = await getJson('/api/v1/billing/plans');
    assert(plans.plans?.some((plan) => plan.id === 'pro-monthly'), 'Pro plan missing');

    const freeBatch = await fetch(`${apiBaseUrl}/api/v1/batches`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        fileNames: ['a.mp4', 'b.mp4'],
        outputQuality: '4k',
      }),
    });
    assert(freeBatch.status === 400, 'Free user should not create Pro batch');

    const intent = await postJson('/api/v1/billing/checkout-intents', {}, token);
    assert(intent.provider === 'mock-stripe', 'checkout provider missing');

    const paid = await postJson(`/api/v1/billing/checkout-intents/${intent.id}/confirm`, {}, token);
    assert(paid.user?.planType === 'pro', 'checkout did not upgrade user to Pro');

    const batch = await postJson('/api/v1/batches', {
      fileNames: ['one.mp4', 'two.mp4', 'three.mp4'],
      outputQuality: '4k',
    }, token);
    assert(batch.status === 'completed' && batch.items?.length === 3, 'Pro batch did not complete');

    const history = await getJson('/api/v1/history', token);
    assert(history.batches?.length === 1 && history.checkouts?.length === 1, 'history missing commercial records');

    const experiment = await getJson('/api/v1/experiments/pro-cta?visitorId=phase4-smoke');
    assert(['control', 'pro-benefits'].includes(experiment.variant), 'experiment variant missing');

    const summary = await getJson('/api/v1/admin/commercial-summary');
    assert(summary.proUsers === 1 && summary.batches === 1, 'commercial summary did not update');

    const cancelled = await postJson('/api/v1/billing/subscription/cancel', {}, token);
    assert(cancelled.user?.planType === 'free', 'subscription cancel did not downgrade user');

    console.log(`Phase 4 smoke passed: checkout ${intent.id}, batch ${batch.id}`);
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
    headers: authHeaders(token),
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

function authHeaders(token) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
  };
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
