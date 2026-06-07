import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { V1Error, V1Service, type V1AuthChallenge } from './v1.service.js';

interface TestStoredUser {
  failedLoginCount: number;
  lockedUntil: string | null;
}

interface TestV1ServiceInternals {
  usersByEmail: Map<string, TestStoredUser>;
}

test('expired login locks are cleared before counting a new failure', async () => {
  const email = 'locked@example.test';
  const service = new V1Service('test-secret', null, [email]);

  const registered = await service.register({
    email,
    username: 'LockedUser',
    password: 'VidLive-Strong-2026!',
  });

  assert.equal(registered.user.planType, 'pro');
  assert.equal(registered.user.dailyQuota, -1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      loginWithChallenge(service, {
        email,
        password: 'wrong-password',
      }),
      isV1Error('invalid-credentials'),
    );
  }

  await assert.rejects(
    loginWithChallenge(service, {
      email,
      password: 'wrong-password',
    }),
    isV1Error('account-locked'),
  );

  const internals = service as unknown as TestV1ServiceInternals;
  const storedUser = internals.usersByEmail.get(email);

  assert.ok(storedUser);
  assert.equal(storedUser.failedLoginCount, 5);
  assert.ok(storedUser.lockedUntil);

  storedUser.lockedUntil = new Date(Date.now() - 1000).toISOString();

  await assert.rejects(
    loginWithChallenge(service, {
      email,
      password: 'wrong-password',
    }),
    isV1Error('invalid-credentials'),
  );

  assert.equal(storedUser.failedLoginCount, 1);
  assert.equal(storedUser.lockedUntil, null);
});

test('login requires a solved one-time challenge', async () => {
  const service = new V1Service('test-secret');
  const email = 'challenge@example.test';

  await service.register({
    email,
    username: 'ChallengeUser',
    password: 'VidLive-Strong-2026!',
  });

  await assert.rejects(
    service.login({
      email,
      password: 'VidLive-Strong-2026!',
    }),
    isV1Error('auth-challenge-required'),
  );

  const login = await loginWithChallenge(service, {
    email,
    password: 'VidLive-Strong-2026!',
  });

  assert.equal(login.user.email, email);
  assert.ok(login.token);
});

async function loginWithChallenge(
  service: V1Service,
  input: { email: string; password: string },
): Promise<{ user: { email: string }; token: string }> {
  const challenge = service.createLoginChallenge();

  return service.login({
    ...input,
    challengeId: challenge.id,
    challengeAnswer: solveChallenge(challenge),
  });
}

function solveChallenge(challenge: V1AuthChallenge): string {
  for (let answer = 0; answer <= 10_000_000; answer += 1) {
    const value = answer.toString();
    const digest = createHash('sha256').update(`${challenge.id}:${challenge.nonce}:${value}`).digest('hex');

    if (digest.startsWith(challenge.prefix)) {
      return value;
    }
  }

  throw new Error('Failed to solve auth challenge.');
}

function isV1Error(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof V1Error && error.code === code;
}
