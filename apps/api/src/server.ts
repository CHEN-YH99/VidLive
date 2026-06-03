import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerConversionRoutes } from './modules/conversions/conversion.routes.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
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
  });

  await server.register(multipart, {
    limits: {
      fileSize: config.cloudFileSizeBytes,
      files: 1,
    },
  });

  registerHealthRoutes(server);
  registerConversionRoutes(server, config);

  server.setErrorHandler((error, _request, reply) => {
    server.log.error(error);

    reply.status(500).send({
      code: 'internal-server-error',
      message: 'Unexpected server error.',
    });
  });

  return server;
}
