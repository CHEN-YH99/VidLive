import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
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
      // P2-25: 自动脱敏日志中的敏感信息
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            headers: {
              ...request.headers,
              authorization: request.headers.authorization ? '***' : undefined,
              cookie: request.headers.cookie ? '***' : undefined,
            },
            remoteAddress: request.ip,
          };
        },
      },
    },
    bodyLimit: config.cloudFileSizeBytes,
    trustProxy: true, // P0-9: 信任代理，正确获取客户端 IP
  });

  await server.register(cors, {
    origin: config.corsOrigin,
    credentials: true,
  });

  await server.register(helmet, {
    // 配置内容安全策略
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    // HTTP 严格传输安全
    hsts: {
      maxAge: 31536000, // 1 年
      includeSubDomains: true,
      preload: true,
    },
    // 其他安全头
    frameguard: { action: 'deny' }, // 防止点击劫持
    xssFilter: true, // XSS 过滤器
    noSniff: true, // 防止 MIME 类型嗅探
  });

  // P1-15: 全局限流（宽松，针对一般查询）
  await server.register(rateLimit, {
    max: 100, // 每个 IP 每分钟最多 100 次请求
    timeWindow: '1 minute',
    cache: 10000, // 缓存 10000 个 IP
    allowList: ['127.0.0.1'], // 本地请求不限制
    skipOnError: true, // Redis 故障时不阻塞请求
  });

  await server.register(multipart, {
    limits: {
      fileSize: config.cloudFileSizeBytes,
      files: 1,
    },
  });

  registerHealthRoutes(server);

  // phase0 调试接口仅在非生产环境注册
  if (process.env.NODE_ENV !== 'production') {
    registerPhaseZeroRoutes(server, config);
  }

  // 先初始化 V1 服务，用于转码接口鉴权
  const v1Service = await registerV1Routes(server, config);
  await registerConversionRoutes(server, config, v1Service);
  registerCompatibilityRoutes(server, config);

  // P2-28: 统一错误处理，生产环境不泄露堆栈
  server.setErrorHandler((error, request, reply) => {
    server.log.error(error);

    const isDevelopment = process.env.NODE_ENV !== 'production';
    const statusCode = (error as any).statusCode || 500;
    const code = (error as any).code || 'internal-server-error';
    const message = error instanceof Error ? error.message : '服务器处理请求时出现异常。';
    const stack = error instanceof Error ? error.stack : undefined;

    reply.status(statusCode).send({
      code,
      message: isDevelopment ? message : '服务器处理请求时出现异常。',
      ...(isDevelopment && stack ? { stack } : {}),
    });
  });

  return server;
}
