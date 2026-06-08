import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { sendResendEmail } from './v1.email-resend.js';

test('sendResendEmail posts a verification email to the Resend API', async () => {
  let requestBody = '';
  let authorization = '';
  let requestPath = '';
  const server = http.createServer((request, response) => {
    requestPath = request.url ?? '';
    authorization = request.headers.authorization ?? '';
    request.on('data', (chunk) => {
      requestBody += chunk.toString('utf8');
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'email-test-id' }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();

    assert.ok(address && typeof address === 'object');

    await sendResendEmail(
      {
        apiKey: 're_test_key',
        apiUrl: `http://127.0.0.1:${address.port}/emails`,
        timeoutMilliseconds: 1000,
      },
      {
        from: 'VidLive <no-reply@example.test>',
        to: 'target@example.test',
        subject: 'VidLive 注册邮箱验证码',
        text: '验证码：123456',
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  assert.equal(requestPath, '/emails');
  assert.equal(authorization, 'Bearer re_test_key');

  const payload = JSON.parse(requestBody) as {
    from?: string;
    to?: string[];
    subject?: string;
    text?: string;
  };

  assert.equal(payload.from, 'VidLive <no-reply@example.test>');
  assert.deepEqual(payload.to, ['target@example.test']);
  assert.equal(payload.subject, 'VidLive 注册邮箱验证码');
  assert.equal(payload.text, '验证码：123456');
});
