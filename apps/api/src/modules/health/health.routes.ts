import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(server: FastifyInstance): void {
  server.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'vidlive-api',
      timestamp: new Date().toISOString(),
    };
  });
}
