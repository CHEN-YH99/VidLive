import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { V1Error, V1Service } from './v1.service.js';

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

export function registerV1Routes(server: FastifyInstance, config: AppConfig): void {
  const service = new V1Service(config.jwtSecret);

  server.post<{ Body: AuthBody }>('/api/v1/auth/register', async (request, reply) => {
    try {
      return await service.register({
        email: request.body.email ?? '',
        password: request.body.password ?? '',
        username: request.body.username ?? '',
      });
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.post<{ Body: AuthBody }>('/api/v1/auth/login', async (request, reply) => {
    try {
      return await service.login({
        email: request.body.email ?? '',
        password: request.body.password ?? '',
      });
    } catch (error) {
      return sendV1Error(reply, error);
    }
  });

  server.get('/api/v1/me', async (request, reply) => {
    const user = authenticateRequest(service, request);

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
    const user = authenticateRequest(service, request);

    if (!user) {
      return reply.status(401).send({
        code: 'unauthorized',
        message: 'Bearer token is required.',
      });
    }

    return service.getUsage(user.id);
  });

  server.post('/api/v1/usage/conversions', async (request, reply) => {
    const user = authenticateRequest(service, request);

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
    const user = authenticateRequest(service, request);
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
}

function authenticateRequest(service: V1Service, request: FastifyRequest) {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;

  return service.authenticate(token);
}

function sendV1Error(reply: { status: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  if (error instanceof V1Error) {
    return reply.status(error.code === 'quota-exceeded' ? 429 : 400).send({
      code: error.code,
      message: error.message,
    });
  }

  throw error;
}
