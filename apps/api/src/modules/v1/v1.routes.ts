import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { V1Error, V1Service } from './v1.service.js';

const authCookieName = 'vidlive_session';

interface AuthBody {
  email?: string;
  password?: string;
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
  const service = await V1Service.create(config.jwtSecret, config.databaseUrl, config.permanentMemberEmails);

  server.post<{ Body: AuthBody }>('/api/v1/auth/register', async (request, reply) => {
    try {
      const session = await service.register({
        email: request.body.email ?? '',
        password: request.body.password ?? '',
        username: request.body.username ?? '',
      });

      setAuthCookie(reply, session.token, config.authCookieSecure);

      return session;
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post<{ Body: AuthBody }>('/api/v1/auth/login', async (request, reply) => {
    try {
      const session = await service.login({
        email: request.body.email ?? '',
        password: request.body.password ?? '',
      });

      setAuthCookie(reply, session.token, config.authCookieSecure);

      return session;
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
        message: 'Bearer token is required.',
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
        message: 'Bearer token is required.',
      });
    }

    return service.getUsage(user.id);
  });

  server.post('/api/v1/usage/conversions', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: 'Bearer token is required.',
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
      note: 'Use a real Stripe provider before production charging.',
    };
  });

  server.post('/api/v1/billing/checkout-intents', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: 'Bearer token is required.',
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
        message: 'Bearer token is required.',
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
        message: 'Bearer token is required.',
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
        message: 'Batch was not found.',
      });
    }

    return batch;
  });

  server.get('/api/v1/history', async (request, reply) => {
    const user = await authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: 'Bearer token is required.',
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
        message: 'Bearer token is required.',
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
        message: 'Bearer token is required.',
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
        message: 'Bearer token is required.',
      });
    }

    return service.createApiKey(user.id, request.body.label ?? 'Default API key');
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

function setAuthCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.header('Set-Cookie', serializeAuthCookie(`${authCookieName}=${encodeURIComponent(token)}`, secure, 7 * 24 * 60 * 60));
}

function clearAuthCookie(reply: FastifyReply, secure: boolean): void {
  reply.header('Set-Cookie', serializeAuthCookie(`${authCookieName}=`, secure, 0));
}

function serializeAuthCookie(prefix: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    prefix,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
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
