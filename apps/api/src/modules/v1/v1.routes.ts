import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { V1Error, V1Service, type V1AuthRequestContext } from './v1.service.js';
import type { EmailVerificationPurpose } from './v1.auth-store.js';

const authCookieName = 'vidlive_session';
const deviceCookieName = 'vidlive_device';
const rememberedAuthCookieMaxAgeSeconds = 3 * 24 * 60 * 60;
const deviceCookieMaxAgeSeconds = 365 * 24 * 60 * 60;

interface AuthBody {
  email?: string;
  password?: string;
  username?: string;
  emailCode?: string;
  loginTicket?: string;
  remember?: boolean;
  challengeId?: string;
  challengeAnswer?: string;
  automationTrap?: string;
}

interface EmailCodeBody {
  email?: string;
  purpose?: EmailVerificationPurpose;
  username?: string;
}

interface KeyframeBody {
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  hasAudio?: boolean | null;
}

interface FeedbackBody {
  presetId?: string;
  device?: string;
  iosVersion?: string;
  savedToPhotos?: boolean;
  lockScreenPlayed?: boolean;
  notes?: string;
}

interface CheckoutParams {
  intentId: string;
}

interface BatchParams {
  batchId: string;
}

interface BatchBody {
  fileNames?: string[];
  outputQuality?: 'standard' | '4k';
}

interface ExperimentQuery {
  visitorId?: string;
}

interface ApiKeyBody {
  label?: string;
}

interface ToolParams {
  toolId: string;
}

export async function registerV1Routes(server: FastifyInstance, config: AppConfig): Promise<void> {
  const service = await V1Service.create(config.jwtSecret, config.databaseUrl, config.permanentMemberEmails, {
    emailCodeWebhookUrl: config.emailCodeWebhookUrl,
    emailCodeFrom: config.emailCodeFrom,
    emailCodeLogEnabled: config.emailCodeLogEnabled,
  });

  server.get('/api/v1/auth/challenge', async () => {
    return service.createLoginChallenge();
  });

  server.post<{ Body: EmailCodeBody }>('/api/v1/auth/email-codes', async (request, reply) => {
    try {
      const context = createAuthRequestContext(request, reply, config.authCookieSecure);
      const purpose: EmailVerificationPurpose = isEmailVerificationPurpose(request.body.purpose) ? request.body.purpose : 'register';
      const emailCodeInput: {
        email: string;
        purpose: EmailVerificationPurpose;
        username?: string;
        context: V1AuthRequestContext;
      } = {
        email: request.body.email ?? '',
        purpose,
        context,
      };

      if (request.body.username !== undefined) {
        emailCodeInput.username = request.body.username;
      }

      return await service.requestEmailCode(emailCodeInput);
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post<{ Body: AuthBody }>('/api/v1/auth/register', async (request, reply) => {
    try {
      const context = createAuthRequestContext(request, reply, config.authCookieSecure);

      return await service.register({
        email: request.body.email ?? '',
        password: request.body.password ?? '',
        username: request.body.username ?? '',
        emailCode: request.body.emailCode ?? '',
        context,
      });
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post<{ Body: AuthBody }>('/api/v1/auth/login', async (request, reply) => {
    try {
      const context = createAuthRequestContext(request, reply, config.authCookieSecure);
      const loginInput: {
        email: string;
        password: string;
        remember?: boolean;
        challengeId?: string;
        challengeAnswer?: string;
        automationTrap?: string;
        context: ReturnType<typeof createAuthRequestContext>;
      } = {
        email: request.body.email ?? '',
        password: request.body.password ?? '',
        remember: request.body.remember === true,
        context,
      };

      if (request.body.challengeId !== undefined) {
        loginInput.challengeId = request.body.challengeId;
      }

      if (request.body.challengeAnswer !== undefined) {
        loginInput.challengeAnswer = request.body.challengeAnswer;
      }

      if (request.body.automationTrap !== undefined) {
        loginInput.automationTrap = request.body.automationTrap;
      }

      const session = await service.login(loginInput);

      if ('requiresEmailCode' in session) {
        return reply.status(202).send(session);
      }

      setAuthCookie(
        reply,
        session.token,
        config.authCookieSecure,
        request.body.remember === true ? rememberedAuthCookieMaxAgeSeconds : null,
      );

      return session;
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post<{ Body: AuthBody }>('/api/v1/auth/login/email-code', async (request, reply) => {
    try {
      const context = createAuthRequestContext(request, reply, config.authCookieSecure);
      const session = await service.verifyLoginEmailCode({
        loginTicket: request.body.loginTicket ?? '',
        emailCode: request.body.emailCode ?? '',
        context,
      });

      setAuthCookie(
        reply,
        session.token,
        config.authCookieSecure,
        session.remember ? rememberedAuthCookieMaxAgeSeconds : null,
      );

      return {
        user: session.user,
        token: session.token,
      };
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post<{ Body: AuthBody }>('/api/v1/auth/reset-password', async (request, reply) => {
    try {
      return await service.resetPassword({
        email: request.body.email ?? '',
        password: request.body.password ?? '',
        emailCode: request.body.emailCode ?? '',
      });
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post('/api/v1/auth/logout', async (_request, reply) => {
    clearAuthCookie(reply, config.authCookieSecure);

    return {
      ok: true,
    };
  });

  server.get('/api/v1/auth/session', async (request) => {
    const user = await authenticateRequest(service, request);

    return {
      user,
      usage: user ? service.getUsage(user.id) : null,
    };
  });

  server.get('/api/v1/me', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    return {
      user,
      usage: service.getUsage(user.id),
    };
  });

  server.get('/api/v1/usage', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    return service.getUsage(user.id);
  });

  server.post('/api/v1/usage/conversions', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    try {
      return service.consumeConversionQuota(user.id, {
        source: 'api/v1/usage/conversions',
      });
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post<{ Body: KeyframeBody }>('/api/v1/keyframes/recommendations', async (request) => {
    return {
      recommendations: service.recommendKeyframes(request.body),
      model: 'heuristic-v1',
      reviewTarget: '人工评估准确率 >= 70%',
    };
  });

  server.post<{ Body: FeedbackBody }>('/api/v1/compatibility-feedback', async (request) => {
    const user = await authenticateRequest(service, request);
    const feedback = {
      userId: user?.id ?? null,
      presetId: request.body.presetId ?? 'unknown',
      device: request.body.device ?? 'unknown',
      iosVersion: request.body.iosVersion ?? 'unknown',
      savedToPhotos: request.body.savedToPhotos === true,
      lockScreenPlayed: request.body.lockScreenPlayed === true,
    };

    return service.addCompatibilityFeedback(
      request.body.notes === undefined
        ? feedback
        : {
            ...feedback,
            notes: request.body.notes,
          },
    );
  });

  server.get('/api/v1/compatibility-feedback/summary', async () => {
    return service.getCompatibilitySummary();
  });

  server.get('/api/v1/metrics/summary', async () => {
    return service.getMetricsSummary();
  });

  server.get('/api/v1/launch-readiness', async () => {
    return {
      status: 'v1-gated',
      checks: service.getLaunchReadiness(),
    };
  });

  server.get('/api/v1/billing/plans', async () => {
    return {
      plans: service.getPlans(),
      provider: 'mock-stripe',
      note: '当前为 VidLive 内置支付流程模拟器，生产收费前需接入正式支付渠道。',
    };
  });

  server.post('/api/v1/billing/checkout-intents', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    return service.createCheckoutIntent(user.id);
  });

  server.post<{ Params: CheckoutParams }>('/api/v1/billing/checkout-intents/:intentId/confirm', async (request, reply) => {
    try {
      return service.confirmCheckoutIntent(request.params.intentId);
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post('/api/v1/billing/subscription/cancel', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    return {
      user: service.cancelSubscription(user.id),
    };
  });

  server.post<{ Body: BatchBody }>('/api/v1/batches', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    try {
      return service.createBatch({
        userId: user.id,
        fileNames: request.body.fileNames ?? [],
        outputQuality: request.body.outputQuality ?? 'standard',
      });
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.get<{ Params: BatchParams }>('/api/v1/batches/:batchId', async (request, reply) => {
    const batch = service.getBatch(request.params.batchId);

    if (!batch) {
      return reply.status(404).send({
        code: 'batch-not-found',
        message: '未找到对应的批量导出任务。',
      });
    }

    return batch;
  });

  server.get('/api/v1/history', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    return service.getHistory(user.id);
  });

  server.get<{ Querystring: ExperimentQuery }>('/api/v1/experiments/pro-cta', async (request) => {
    return service.assignExperiment(request.query.visitorId ?? 'anonymous');
  });

  server.get('/api/v1/admin/commercial-summary', async () => {
    return service.getCommercialSummary();
  });

  server.get('/api/v1/tools', async () => {
    return {
      tools: service.getExpansionTools(),
    };
  });

  server.post<{ Params: ToolParams }>('/api/v1/tools/:toolId/intents', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    try {
      return service.createToolIntent(user.id, request.params.toolId);
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.get('/api/v1/templates', async () => {
    return {
      templates: service.getTemplates(),
    };
  });

  server.get('/api/v1/api-keys', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    return {
      keys: service.listApiKeys(user.id),
    };
  });

  server.post<{ Body: ApiKeyBody }>('/api/v1/api-keys', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: '请登录后再访问该 VidLive 接口。',
      });
    }

    return service.createApiKey(user.id, request.body.label ?? 'VidLive API 密钥');
  });

  server.get('/api/v1/extensions/browser-manifest', async () => {
    return service.getBrowserExtensionManifest();
  });

  server.get('/api/v1/desktop/manifest', async () => {
    return service.getDesktopManifest();
  });

  server.get('/api/v1/ecosystem/summary', async () => {
    return service.getExpansionSummary();
  });
}

async function authenticateRequest(service: V1Service, request: FastifyRequest) {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : readCookie(request, authCookieName);

  return service.authenticate(token);
}

function sendV1Error(reply: { status: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  if (error instanceof V1Error) {
    const statusCode = error.code === 'quota-exceeded' ? 429 : error.code === 'account-locked' ? 423 : 400;

    return reply.status(statusCode).send({
      code: error.code,
      message: error.message,
    });
  }

  throw error;
}

function createAuthRequestContext(request: FastifyRequest, reply: FastifyReply, secure: boolean): V1AuthRequestContext {
  const existingDeviceId = readCookie(request, deviceCookieName);
  const deviceId = existingDeviceId && /^[0-9a-f-]{36}$/iu.test(existingDeviceId) ? existingDeviceId : randomUUID();

  if (deviceId !== existingDeviceId) {
    appendSetCookie(
      reply,
      serializeAuthCookie(`${deviceCookieName}=${encodeURIComponent(deviceId)}`, secure, deviceCookieMaxAgeSeconds),
    );
  }

  return {
    requestIp: request.ip,
    userAgent: Array.isArray(request.headers['user-agent'])
      ? request.headers['user-agent'].join(' ')
      : (request.headers['user-agent'] ?? ''),
    deviceId,
  };
}

function isEmailVerificationPurpose(value: unknown): value is EmailVerificationPurpose {
  return value === 'register' || value === 'login' || value === 'reset-password';
}

function setAuthCookie(reply: FastifyReply, token: string, secure: boolean, maxAgeSeconds: number | null): void {
  appendSetCookie(reply, serializeAuthCookie(`${authCookieName}=${encodeURIComponent(token)}`, secure, maxAgeSeconds));
}

function clearAuthCookie(reply: FastifyReply, secure: boolean): void {
  appendSetCookie(reply, serializeAuthCookie(`${authCookieName}=`, secure, 0));
}

function appendSetCookie(reply: FastifyReply, cookie: string): void {
  const current = reply.getHeader('Set-Cookie');

  if (!current) {
    reply.header('Set-Cookie', cookie);
    return;
  }

  if (Array.isArray(current)) {
    reply.header('Set-Cookie', [...current.map(String), cookie]);
    return;
  }

  reply.header('Set-Cookie', [String(current), cookie]);
}

function serializeAuthCookie(prefix: string, secure: boolean, maxAgeSeconds: number | null): string {
  return [
    prefix,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    maxAgeSeconds === null ? '' : `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const cookieHeader = request.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');

    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join('='));
      } catch {
        return null;
      }
    }
  }

  return null;
}
