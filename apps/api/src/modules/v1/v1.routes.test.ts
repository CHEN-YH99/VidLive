import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { registerV1Routes } from './v1.routes.js';

test('email code route returns a validation error when the request body is missing', async () => {
  const server = await createTestServer();

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/email-codes',
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
      code: 'invalid-email',
      message: '请输入有效邮箱地址。',
    });
  } finally {
    await server.close();
  }
});

test('auth routes reject malformed bodies without leaking an internal server error', async () => {
  const server = await createTestServer();
  const cases = [
    ['/api/v1/auth/email-codes', 'invalid-email'],
    ['/api/v1/auth/register', 'invalid-email'],
    ['/api/v1/auth/login', 'invalid-credentials'],
    ['/api/v1/auth/login/email-code', 'login-ticket-expired'],
    ['/api/v1/auth/reset-password', 'invalid-email'],
  ] as const;

  try {
    for (const [url, code] of cases) {
      const response = await server.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
        },
        payload: '[]',
      });

      assert.equal(response.statusCode, 400);
      assert.equal((JSON.parse(response.body) as { code?: string }).code, code);
    }
  } finally {
    await server.close();
  }
});

async function createTestServer() {
  const server = Fastify({
    logger: false,
  });

  await registerV1Routes(server, createTestConfig());

  return server;
}

function createTestConfig(): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    corsOrigin: 'http://localhost:3000',
    logLevel: 'silent',
    uploadDir: './tmp/test-uploads',
    localFileSizeBytes: 10_000_000,
    cloudFileSizeBytes: 10_000_000,
    cloudRetentionHours: 24,
    cloudQueueConcurrency: 1,
    databaseUrl: null,
    redisUrl: null,
    r2Endpoint: null,
    r2AccessKeyId: null,
    r2SecretAccessKey: null,
    r2Bucket: null,
    r2SignedUrlTtlSeconds: 3600,
    jwtSecret: 'test-secret-with-at-least-32-characters',
    authCookieSecure: false,
    v1StorePath: './tmp/test-v1-store.json',
    permanentMemberEmails: [],
    emailCodeWebhookUrl: null,
    emailCodeFrom: 'VidLive <no-reply@example.test>',
    emailCodeLogEnabled: false,
    resendApiKey: null,
    resendApiUrl: 'https://api.resend.com/emails',
    resendTimeoutMilliseconds: 1000,
    emailCodeSmtpHost: null,
    emailCodeSmtpPort: 587,
    emailCodeSmtpSecure: false,
    emailCodeSmtpUser: null,
    emailCodeSmtpPassword: null,
    emailCodeSmtpTimeoutMilliseconds: 1000,
  };
}
