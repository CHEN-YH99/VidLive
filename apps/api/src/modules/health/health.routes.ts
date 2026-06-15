import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(server: FastifyInstance): void {
  server.get('/api/health', async () => {
    // P2-27: 公开健康检查只返回基本状态，不泄露敏感信息
    return {
      status: 'ok',
      service: 'vidlive-api',
      timestamp: new Date().toISOString(),
    };
  });
}
