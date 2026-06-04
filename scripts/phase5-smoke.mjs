/* global console, fetch, process, setTimeout */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeDir = path.join(root, 'tmp', 'phase5-smoke');
const apiPort = Number(process.env.PHASE5_SMOKE_PORT ?? 3135);
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

async function main() {
  await rm(smokeDir, { recursive: true, force: true });

  const server = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: apiPort.toString(),
      JWT_SECRET: 'phase5-smoke-secret',
      LOG_LEVEL: 'error',
      UPLOAD_DIR: smokeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHealth();

    const email = `phase5-${Date.now()}@vidlive.test`;
    const register = await postJson('/api/v1/auth/register', {
      email,
      username: 'phase5-smoke',
      password: 'phase5-smoke-password',
    });
    const token = register.token;
    const intent = await postJson('/api/v1/billing/checkout-intents', {}, token);
    await postJson(`/api/v1/billing/checkout-intents/${intent.id}/confirm`, {}, token);

    const tools = await getJson('/api/v1/tools');
    assert(tools.tools?.length >= 5, 'tool matrix missing');

    const templates = await getJson('/api/v1/templates');
    assert(templates.templates?.length >= 3, 'templates missing');

    const apiKey = await postJson('/api/v1/api-keys', { label: 'Phase 5 smoke' }, token);
    assert(apiKey.prefix?.startsWith('vl_'), 'API key prefix missing');

    const keys = await getJson('/api/v1/api-keys', token);
    assert(keys.keys?.length === 1, 'API key list missing created key');

    const toolIntent = await postJson('/api/v1/tools/live-photo-to-gif/intents', {}, token);
    assert(toolIntent.status === 'accepted', 'preview tool intent not accepted for Pro');

    const plannedIntent = await postJson('/api/v1/tools/ai-image-motion/intents', {}, token);
    assert(plannedIntent.status === 'planned', 'planned tool intent did not return planned');

    const extension = await getJson('/api/v1/extensions/browser-manifest');
    assert(extension.permissions?.includes('downloads'), 'browser extension manifest missing permissions');

    const desktop = await getJson('/api/v1/desktop/manifest');
    assert(desktop.platforms?.includes('macOS'), 'desktop manifest missing platform');

    const summary = await getJson('/api/v1/ecosystem/summary');
    assert(summary.apiKeys === 1 && summary.tools >= 5, 'ecosystem summary did not update');

    console.log(`Phase 5 smoke passed: api key ${apiKey.prefix}, tools ${summary.tools}`);
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
