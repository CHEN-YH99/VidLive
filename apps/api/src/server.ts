import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCompatibilityRoutes } from './modules/compatibility/compatibility.routes.js';
import { registerConversionRoutes } from './modules/conversions/conversion.routes.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerPhaseZeroRoutes } from './modules/phase0/phase0.routes.js';
import { registerV1Routes } from './modules/v1/v1.routes.js';
import type { AppConfig } from './config/env.js';

export async function createServer(config: AppConfig): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: config.logLevel,
    },
    bodyLimit: config.cloudFileSizeBytes,
  });

  await server.register(cors, {
    origin: config.corsOrigin,
    credentials: true,
  });

  await server.register(multipart, {
    limits: {
      fileSize: config.cloudFileSizeBytes,
      files: 1,
    },
  });

  registerHealthRoutes(server);
  registerPhaseZeroRoutes(server, config);
  registerConversionRoutes(server, config);
  registerCompatibilityRoutes(server, config);
  await registerV1Routes(server, config);

  server.setErrorHandler((error, _request, reply) => {
    server.log.error(error);

    reply.status(500).send({
      code: 'internal-server-error',
      message: 'Unexpected server error.',
    });
  });

  return server;
}
