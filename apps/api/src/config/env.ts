import 'dotenv/config';
import { productLimits } from '@vidlive/shared';

export interface AppConfig {
  host: string;
  port: number;
  corsOrigin: string;
  logLevel: string;
  uploadDir: string;
  localFileSizeBytes: number;
  cloudFileSizeBytes: number;
  cloudRetentionHours: number;
  cloudQueueConcurrency: number;
  databaseUrl: string | null;
  redisUrl: string | null;
  r2Endpoint: string | null;
  r2AccessKeyId: string | null;
  r2SecretAccessKey: string | null;
  r2Bucket: string | null;
  r2SignedUrlTtlSeconds: number;
  jwtSecret: string;
  authCookieSecure: boolean;
  v1StorePath: string;
  permanentMemberEmails: string[];
}

const builtInPermanentMemberEmails = ['1139189851@qq.com'];

function readNumber(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}`);
  }

  return parsed;
}

function readOptionalString(name: string): string | null {
  const value = process.env[name]?.trim();

  return value ? value : null;
}

function readEmailList(name: string): string[] {
  const value = process.env[name]?.trim();

  if (!value) {
    return [];
  }

  return value
    .split(/[,\s]+/u)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.API_HOST ?? '0.0.0.0',
    port: readNumber('API_PORT', 3001),
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    uploadDir: process.env.UPLOAD_DIR ?? './uploads',
    localFileSizeBytes: readNumber('MAX_LOCAL_FILE_SIZE', productLimits.localFileSizeBytes),
    cloudFileSizeBytes: readNumber('MAX_CLOUD_FILE_SIZE', productLimits.cloudFileSizeBytes),
    cloudRetentionHours: readNumber('CLOUD_RETENTION_HOURS', 24),
    cloudQueueConcurrency: readNumber('CLOUD_QUEUE_CONCURRENCY', 1),
    databaseUrl: readOptionalString('DATABASE_URL'),
    redisUrl: readOptionalString('REDIS_URL'),
    r2Endpoint: readOptionalString('R2_ENDPOINT'),
    r2AccessKeyId: readOptionalString('R2_ACCESS_KEY_ID'),
    r2SecretAccessKey: readOptionalString('R2_SECRET_ACCESS_KEY'),
    r2Bucket: readOptionalString('R2_BUCKET'),
    r2SignedUrlTtlSeconds: readNumber('R2_SIGNED_URL_TTL_SECONDS', 60 * 60),
    jwtSecret: process.env.JWT_SECRET ?? 'dev-vidlive-secret-change-me',
    authCookieSecure: process.env.AUTH_COOKIE_SECURE === 'true',
    v1StorePath: process.env.V1_STORE_PATH ?? './data/v1-store.json',
    permanentMemberEmails: [...new Set([...builtInPermanentMemberEmails, ...readEmailList('PERMANENT_MEMBER_EMAILS')])],
  };
}
