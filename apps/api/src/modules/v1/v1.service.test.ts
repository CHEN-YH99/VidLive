import assert from 'node:assert/strict';
import { test } from 'node:test';
import { V1Error, V1Service } from './v1.service.js';

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
      service.login({
        email,
        password: 'wrong-password',
      }),
      isV1Error('invalid-credentials'),
    );
  }

  await assert.rejects(
    service.login({
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
    service.login({
      email,
      password: 'wrong-password',
    }),
    isV1Error('invalid-credentials'),
  );

  assert.equal(storedUser.failedLoginCount, 1);
  assert.equal(storedUser.lockedUntil, null);
});

function isV1Error(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof V1Error && error.code === code;
}
