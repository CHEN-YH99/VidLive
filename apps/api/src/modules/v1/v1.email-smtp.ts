import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export interface SmtpEmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  timeoutMilliseconds: number;
}

export interface SmtpEmailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

type SmtpSocket = net.Socket | tls.TLSSocket;
type SmtpCapabilities = Map<string, string[]>;

export async function sendSmtpEmail(config: SmtpEmailConfig, input: SmtpEmailInput): Promise<void> {
  const socket = await openSmtpSocket(config);
  const connection = new SmtpConnection(config, socket);

  try {
    await connection.expect([220], 'connect');
    let capabilities = await connection.ehlo();

    if (!config.secure && capabilities.has('STARTTLS')) {
      await connection.command('STARTTLS', [220]);
      await connection.upgradeToTls();
      capabilities = await connection.ehlo();
    }

    if (config.user || config.password) {
      await connection.authenticate(capabilities);
    }

    const fromAddress = extractEmailAddress(input.from) ?? config.user;
    const toAddress = extractEmailAddress(input.to);

    if (!fromAddress || !toAddress) {
      throw new Error('SMTP sender or recipient address is invalid.');
    }

    await connection.command(`MAIL FROM:<${fromAddress}>`, [250]);
    await connection.command(`RCPT TO:<${toAddress}>`, [250, 251]);
    await connection.command('DATA', [354]);
    connection.writeData(buildMimeMessage(input));
    await connection.expect([250], 'DATA');
    await connection.command('QUIT', [221]);
  } finally {
    connection.destroy();
  }
}

class SmtpConnection {
  private buffer = '';
  private closedError: Error | null = null;
  private waiter: (() => void) | null = null;
  private socket: SmtpSocket;

  private readonly handleData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8');
    this.resolveWaiter();
  };

  private readonly handleError = (error: Error): void => {
    this.closedError = error;
    this.resolveWaiter();
  };

  private readonly handleClose = (): void => {
    this.closedError ??= new Error('SMTP connection closed.');
    this.resolveWaiter();
  };

  constructor(
    private readonly config: SmtpEmailConfig,
    socket: SmtpSocket,
  ) {
    this.socket = socket;
    this.attachSocket(socket);
  }

  async ehlo(): Promise<SmtpCapabilities> {
    const response = await this.command('EHLO vidlive.local', [250]);

    return parseCapabilities(response);
  }

  async authenticate(capabilities: SmtpCapabilities): Promise<void> {
    if (!this.config.user || !this.config.password) {
      throw new Error('SMTP user and password must be configured together.');
    }

    if (!isEncryptedSocket(this.socket)) {
      throw new Error('SMTP authentication requires TLS.');
    }

    const authMechanisms = getAuthMechanisms(capabilities);

    if (authMechanisms.has('PLAIN')) {
      const token = Buffer.from(`\0${this.config.user}\0${this.config.password}`, 'utf8').toString('base64');
      await this.command(`AUTH PLAIN ${token}`, [235]);
      return;
    }

    if (authMechanisms.has('LOGIN')) {
      await this.command('AUTH LOGIN', [334]);
      await this.command(Buffer.from(this.config.user, 'utf8').toString('base64'), [334]);
      await this.command(Buffer.from(this.config.password, 'utf8').toString('base64'), [235]);
      return;
    }

    throw new Error('SMTP server does not support AUTH PLAIN or AUTH LOGIN.');
  }

  async upgradeToTls(): Promise<void> {
    const rawSocket = this.socket;

    this.detachSocket(rawSocket);
    this.buffer = '';
    this.closedError = null;

    const secureSocket = tls.connect({
      socket: rawSocket,
      servername: this.config.host,
    });

    await waitForSecureConnect(secureSocket, this.config.timeoutMilliseconds);
    this.socket = secureSocket;
    this.attachSocket(secureSocket);
  }

  async command(command: string, expectedCodes: number[]): Promise<SmtpResponse> {
    this.writeLine(command);

    return this.expect(expectedCodes, command);
  }

  async expect(expectedCodes: number[], label: string): Promise<SmtpResponse> {
    const response = await this.readResponse();

    if (!expectedCodes.includes(response.code)) {
      throw new Error(`SMTP ${label} failed: ${response.lines.join(' | ')}`);
    }

    return response;
  }

  writeData(message: string): void {
    const normalized = message.replace(/\r?\n/gu, '\r\n').replace(/^\./gmu, '..');
    const suffix = normalized.endsWith('\r\n') ? '.\r\n' : '\r\n.\r\n';

    this.socket.write(`${normalized}${suffix}`);
  }

  destroy(): void {
    this.detachSocket(this.socket);
    this.socket.destroy();
  }

  private writeLine(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  private async readResponse(): Promise<SmtpResponse> {
    while (true) {
      const parsed = tryParseResponse(this.buffer);

      if (parsed) {
        this.buffer = parsed.remaining;
        return parsed.response;
      }

      if (this.closedError) {
        throw this.closedError;
      }

      await this.waitForData();
    }
  }

  private async waitForData(): Promise<void> {
    if (this.closedError) {
      throw this.closedError;
    }

    await new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  private resolveWaiter(): void {
    const waiter = this.waiter;

    this.waiter = null;
    waiter?.();
  }

  private attachSocket(socket: SmtpSocket): void {
    socket.setTimeout(this.config.timeoutMilliseconds, () => {
      socket.destroy(new Error('SMTP connection timed out.'));
    });
    socket.on('data', this.handleData);
    socket.on('error', this.handleError);
    socket.on('close', this.handleClose);
  }

  private detachSocket(socket: SmtpSocket): void {
    socket.off('data', this.handleData);
    socket.off('error', this.handleError);
    socket.off('close', this.handleClose);
    socket.setTimeout(0);
  }
}

function openSmtpSocket(config: SmtpEmailConfig): Promise<SmtpSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({
          host: config.host,
          port: config.port,
          servername: config.host,
        })
      : net.createConnection({
          host: config.host,
          port: config.port,
        });

    const handleConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const handleTimeout = (): void => {
      socket.destroy(new Error('SMTP connection timed out.'));
    };
    const cleanup = (): void => {
      socket.off(config.secure ? 'secureConnect' : 'connect', handleConnect);
      socket.off('error', handleError);
      socket.off('timeout', handleTimeout);
    };

    socket.setTimeout(config.timeoutMilliseconds);
    socket.once(config.secure ? 'secureConnect' : 'connect', handleConnect);
    socket.once('error', handleError);
    socket.once('timeout', handleTimeout);
  });
}

function waitForSecureConnect(socket: tls.TLSSocket, timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy(new Error('SMTP STARTTLS timed out.'));
    }, timeoutMilliseconds);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off('secureConnect', handleConnect);
      socket.off('error', handleError);
    };
    const handleConnect = (): void => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    socket.once('secureConnect', handleConnect);
    socket.once('error', handleError);
  });
}

function tryParseResponse(buffer: string): { response: SmtpResponse; remaining: string } | null {
  let cursor = 0;
  const lines: string[] = [];

  while (true) {
    const lineEnd = buffer.indexOf('\r\n', cursor);

    if (lineEnd === -1) {
      return null;
    }

    const line = buffer.slice(cursor, lineEnd);
    lines.push(line);
    cursor = lineEnd + 2;

    if (/^\d{3} /u.test(line)) {
      return {
        response: {
          code: Number(line.slice(0, 3)),
          lines,
        },
        remaining: buffer.slice(cursor),
      };
    }

    if (!/^\d{3}-/u.test(line)) {
      throw new Error(`Invalid SMTP response: ${line}`);
    }
  }
}

function parseCapabilities(response: SmtpResponse): SmtpCapabilities {
  const capabilities: SmtpCapabilities = new Map();

  for (const line of response.lines) {
    const content = line.slice(4).trim();

    if (!content) {
      continue;
    }

    const [name, ...values] = content.split(/\s+/u);
    const [rawKey, inlineValue] = name?.split('=') ?? [];
    const key = rawKey?.toUpperCase();

    if (!key) {
      continue;
    }

    const current = capabilities.get(key) ?? [];
    current.push([inlineValue, ...values].filter(Boolean).join(' '));
    capabilities.set(key, current);
  }

  return capabilities;
}

function getAuthMechanisms(capabilities: SmtpCapabilities): Set<string> {
  return new Set(
    (capabilities.get('AUTH') ?? [])
      .flatMap((value) => value.split(/\s+/u))
      .map((value) => value.toUpperCase())
      .filter(Boolean),
  );
}

function buildMimeMessage(input: SmtpEmailInput): string {
  const fromAddress = extractEmailAddress(input.from);
  const messageIdDomain = fromAddress?.split('@')[1] ?? 'vidlive.local';

  return [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${messageIdDomain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(input.text, 'utf8').toString('base64')),
  ].join('\r\n');
}

function encodeMimeHeader(value: string): string {
  const sanitized = sanitizeHeader(value);

  if (/^[\x20-\x7e]*$/u.test(sanitized)) {
    return sanitized;
  }

  return `=?UTF-8?B?${Buffer.from(sanitized, 'utf8').toString('base64')}?=`;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim();
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/gu)?.join('\r\n') ?? '';
}

function extractEmailAddress(value: string): string | null {
  const match = value.match(/<([^<>\s@]+@[^<>\s@]+)>/u) ?? value.match(/([^\s<>@]+@[^\s<>@]+)/u);
  const email = match?.[1]?.trim().toLowerCase();

  if (!email || /[\r\n]/u.test(email) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email)) {
    return null;
  }

  return email;
}

function isEncryptedSocket(socket: SmtpSocket): boolean {
  return socket instanceof tls.TLSSocket && socket.encrypted;
}
