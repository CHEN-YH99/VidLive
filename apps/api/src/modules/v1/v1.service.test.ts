import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { V1Error, V1Service, type V1AuthChallenge, type V1AuthRequestContext } from './v1.service.js';

interface TestStoredUser {
  failedLoginCount: number;
  lockedUntil: string | null;
}

interface TestV1ServiceInternals {
  usersByEmail: Map<string, TestStoredUser>;
}

const testEmailCode = '123456';
const testPassword = 'VidLive-Strong-2026!';

test('expired login locks are cleared before counting a new failure', async () => {
  const email = 'locked@example.test';
  const service = createTestService([email]);

  const registered = await registerWithEmailCode(service, {
    email,
    username: 'LockedUser',
    password: testPassword,
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

  const refreshedStoredUser = internals.usersByEmail.get(email);

  assert.ok(refreshedStoredUser);
  assert.equal(refreshedStoredUser.failedLoginCount, 1);
  assert.equal(refreshedStoredUser.lockedUntil, null);
});

test('login requires a solved one-time challenge', async () => {
  const service = createTestService();
  const email = 'challenge@example.test';

  await registerWithEmailCode(service, {
    email,
    username: 'ChallengeUser',
    password: testPassword,
  });

  await assert.rejects(
    service.login({
      email,
      password: testPassword,
    }),
    isV1Error('auth-challenge-required'),
  );

  const login = await loginWithChallenge(service, {
    email,
    password: testPassword,
  });

  assert.equal(login.user.email, email);
  assert.ok(login.token);
});

test('registration requires a valid email verification code', async () => {
  const service = createTestService();
  const email = 'missing-code@example.test';

  await assert.rejects(
    service.register({
      email,
      username: 'MissingCodeUser',
      password: testPassword,
      context: createAuthContext('missing-code-device'),
    }),
    isV1Error('invalid-email-code'),
  );
});

test('registration succeeds with a verified email code', async () => {
  const service = createTestService();
  const email = 'register-code@example.test';

  const result = await registerWithEmailCode(service, {
    email,
    username: 'RegisterCodeUser',
    password: testPassword,
  });

  assert.equal(result.user.email, email);
  assert.equal(result.user.username, 'RegisterCodeUser');
  assert.equal(result.user.planType, 'free');
});

test('login from a new device requires email code and can be completed', async () => {
  const service = createTestService();
  const email = 'login-code@example.test';
  const registrationContext = createAuthContext('login-known-device');
  const loginContext = createAuthContext('login-new-device');

  await registerWithEmailCode(service, {
    email,
    username: 'LoginCodeUser',
    password: testPassword,
    context: registrationContext,
  });

  const challenge = service.createLoginChallenge();
  const challengedLogin = await withMutedConsoleInfo(() =>
    service.login({
      email,
      password: testPassword,
      challengeId: challenge.id,
      challengeAnswer: solveChallenge(challenge),
      remember: true,
      context: loginContext,
    }),
  );

  assert.ok('requiresEmailCode' in challengedLogin);
  assert.equal(challengedLogin.email, email);
  assert.ok(challengedLogin.loginTicket);

  const verifiedLogin = await service.verifyLoginEmailCode({
    loginTicket: challengedLogin.loginTicket,
    emailCode: testEmailCode,
    context: loginContext,
  });

  assert.equal(verifiedLogin.user.email, email);
  assert.equal(verifiedLogin.remember, true);
  assert.ok(verifiedLogin.token);
});

test('reset password verifies email code before changing credentials', async () => {
  const service = createTestService();
  const email = 'reset-password@example.test';
  const newPassword = 'VidLive-New-2026!';

  await registerWithEmailCode(service, {
    email,
    username: 'ResetPasswordUser',
    password: testPassword,
  });

  await withMutedConsoleInfo(() =>
    service.requestEmailCode({
      email,
      purpose: 'reset-password',
      context: createAuthContext('reset-password-device'),
    }),
  );

  await service.resetPassword({
    email,
    password: newPassword,
    emailCode: testEmailCode,
  });

  await assert.rejects(
    loginWithChallenge(service, {
      email,
      password: testPassword,
    }),
    isV1Error('invalid-credentials'),
  );

  const login = await loginWithChallenge(service, {
    email,
    password: newPassword,
  });

  assert.equal(login.user.email, email);
  assert.ok(login.token);
});

async function loginWithChallenge(
  service: V1Service,
  input: { email: string; password: string },
): Promise<{ user: { email: string }; token: string }> {
  const challenge = service.createLoginChallenge();

  const result = await service.login({
    ...input,
    challengeId: challenge.id,
    challengeAnswer: solveChallenge(challenge),
  });

  if ('requiresEmailCode' in result) {
    throw new Error('Unexpected login email verification challenge.');
  }

  return result;
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

function createTestService(permanentMemberEmails: readonly string[] = []): V1Service {
  return new V1Service('test-secret', null, permanentMemberEmails, {
    emailCodeGenerator: () => testEmailCode,
    emailCodeLogEnabled: true,
  });
}

async function registerWithEmailCode(
  service: V1Service,
  input: {
    email: string;
    username: string;
    password: string;
    context?: V1AuthRequestContext;
  },
): Promise<{ user: { email: string; username: string; planType: 'free' | 'pro'; dailyQuota: number } }> {
  const context = input.context ?? createAuthContext(`register-${input.email}`);

  await withMutedConsoleInfo(() =>
    service.requestEmailCode({
      email: input.email,
      purpose: 'register',
      username: input.username,
      password: input.password,
      context,
    }),
  );

  return service.register({
    email: input.email,
    username: input.username,
    password: input.password,
    emailCode: testEmailCode,
    context,
  });
}

function createAuthContext(deviceId: string): V1AuthRequestContext {
  return {
    requestIp: '127.0.0.1',
    userAgent: 'vidlive-test-agent',
    deviceId,
  };
}

async function withMutedConsoleInfo<T>(operation: () => Promise<T>): Promise<T> {
  const previousConsoleInfo = console.info;

  console.info = () => undefined;

  try {
    return await operation();
  } finally {
    console.info = previousConsoleInfo;
  }
}

function isV1Error(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof V1Error && error.code === code;
}
