import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { sendSmtpEmail } from './v1.email-smtp.js';

test('sendSmtpEmail sends a verification email through a plain SMTP server', async () => {
  const messages: string[] = [];
  const commands: string[] = [];
  const server = createTestSmtpServer(messages, commands);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();

    assert.ok(address && typeof address === 'object');

    await sendSmtpEmail(
      {
        host: '127.0.0.1',
        port: address.port,
        secure: false,
        user: null,
        password: null,
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

  assert.deepEqual(commands.slice(0, 5), [
    'EHLO vidlive.local',
    'MAIL FROM:<no-reply@example.test>',
    'RCPT TO:<target@example.test>',
    'DATA',
    'QUIT',
  ]);
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /^To: target@example\.test/mu);
  assert.match(messages[0] ?? '', /^Content-Transfer-Encoding: base64/mu);

  const encodedBody = (messages[0] ?? '').split('\r\n\r\n')[1]?.replace(/\r\n/gu, '') ?? '';
  const decodedBody = Buffer.from(encodedBody, 'base64').toString('utf8');

  assert.match(decodedBody, /验证码：123456/u);
});

function createTestSmtpServer(messages: string[], commands: string[]): net.Server {
  return net.createServer((socket) => {
    let buffer = '';
    let dataMode = false;

    socket.write('220 test.smtp.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      while (true) {
        if (dataMode) {
          const terminatorIndex = buffer.indexOf('\r\n.\r\n');

          if (terminatorIndex === -1) {
            return;
          }

          messages.push(buffer.slice(0, terminatorIndex));
          buffer = buffer.slice(terminatorIndex + '\r\n.\r\n'.length);
          dataMode = false;
          socket.write('250 queued\r\n');
          continue;
        }

        const lineEnd = buffer.indexOf('\r\n');

        if (lineEnd === -1) {
          return;
        }

        const command = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        commands.push(command);

        if (command.startsWith('EHLO ')) {
          socket.write('250-test.smtp.local\r\n250 OK\r\n');
        } else if (command === 'DATA') {
          dataMode = true;
          socket.write('354 end with dot\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });
}
