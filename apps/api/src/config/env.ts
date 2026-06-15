import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { productLimits } from '@vidlive/shared';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

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
  cloudQueueMaxWaiting: number; // P0-8: 队列最大等待数
  cloudUserMaxActiveJobs: number; // P0-8: 单用户最大并发任务数
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
  emailCodeWebhookUrl: string | null;
  emailCodeFrom: string;
  emailCodeLogEnabled: boolean;
  resendApiKey: string | null;
  resendApiUrl: string;
  resendTimeoutMilliseconds: number;
  emailCodeSmtpHost: string | null;
  emailCodeSmtpPort: number;
  emailCodeSmtpSecure: boolean;
  emailCodeSmtpUser: string | null;
  emailCodeSmtpPassword: string | null;
  emailCodeSmtpTimeoutMilliseconds: number;
}

// 移除硬编码邮箱，改为从环境变量读取
// 使用环境变量 PERMANENT_MEMBER_EMAILS 配置永久会员邮箱
// 格式：PERMANENT_MEMBER_EMAILS="email1@example.com,email2@example.com"

const INSECURE_JWT_SECRET = 'dev-vidlive-secret-change-me';
const MIN_JWT_SECRET_LENGTH = 32;

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (!secret || secret === INSECURE_JWT_SECRET || secret.length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `Refusing to start: JWT_SECRET must be set to a non-default value of at least ${MIN_JWT_SECRET_LENGTH} characters in production.`,
      );
    }

    return secret;
  }

  return secret && secret.length > 0 ? secret : INSECURE_JWT_SECRET;
}

function resolveCorsOrigin(): string {
  const origin = process.env.CORS_ORIGIN?.trim();

  // 禁止使用通配符，当 credentials: true 时不安全
  if (origin === '*') {
    throw new Error('Refusing to start: CORS_ORIGIN cannot be wildcard (*) when credentials are enabled.');
  }

  if (origin) {
    return origin;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to start: CORS_ORIGIN must be set in production.');
  }

  return 'http://localhost:3000';
}

function resolveAuthCookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE !== undefined) {
    return process.env.AUTH_COOKIE_SECURE === 'true';
  }

  return process.env.NODE_ENV === 'production';
}

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
  const emailCodeSmtpSecure = process.env.EMAIL_CODE_SMTP_SECURE === 'true';

  return {
    host: process.env.API_HOST ?? '0.0.0.0',
    port: readNumber('API_PORT', 8000),
    corsOrigin: resolveCorsOrigin(),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    uploadDir: process.env.UPLOAD_DIR ?? './uploads',
    localFileSizeBytes: readNumber('MAX_LOCAL_FILE_SIZE', productLimits.localFileSizeBytes),
    cloudFileSizeBytes: readNumber('MAX_CLOUD_FILE_SIZE', productLimits.cloudFileSizeBytes),
    cloudRetentionHours: readNumber('CLOUD_RETENTION_HOURS', 24),
    cloudQueueConcurrency: readNumber('CLOUD_QUEUE_CONCURRENCY', 1),
    cloudQueueMaxWaiting: readNumber('CLOUD_QUEUE_MAX_WAITING', 20), // P0-8
    cloudUserMaxActiveJobs: readNumber('CLOUD_USER_MAX_ACTIVE_JOBS', 1), // P0-8
    databaseUrl: readOptionalString('DATABASE_URL'),
    redisUrl: readOptionalString('REDIS_URL'),
    r2Endpoint: readOptionalString('R2_ENDPOINT'),
    r2AccessKeyId: readOptionalString('R2_ACCESS_KEY_ID'),
    r2SecretAccessKey: readOptionalString('R2_SECRET_ACCESS_KEY'),
    r2Bucket: readOptionalString('R2_BUCKET'),
    r2SignedUrlTtlSeconds: readNumber('R2_SIGNED_URL_TTL_SECONDS', 60 * 60),
    jwtSecret: resolveJwtSecret(),
    authCookieSecure: resolveAuthCookieSecure(),
    v1StorePath: process.env.V1_STORE_PATH ?? './data/v1-store.json',
    permanentMemberEmails: readEmailList('PERMANENT_MEMBER_EMAILS'),
    emailCodeWebhookUrl: readOptionalString('EMAIL_CODE_WEBHOOK_URL'),
    emailCodeFrom: process.env.EMAIL_CODE_FROM ?? 'VidLive <no-reply@vidlive.local>',
    emailCodeLogEnabled: process.env.EMAIL_CODE_LOG_ENABLED
      ? process.env.EMAIL_CODE_LOG_ENABLED === 'true'
      : process.env.NODE_ENV !== 'production',
    resendApiKey: readOptionalString('RESEND_API_KEY'),
    resendApiUrl: readOptionalString('RESEND_API_URL') ?? 'https://api.resend.com/emails',
    resendTimeoutMilliseconds: readNumber('RESEND_TIMEOUT_MS', 10_000),
    emailCodeSmtpHost: readOptionalString('EMAIL_CODE_SMTP_HOST'),
    emailCodeSmtpPort: readNumber('EMAIL_CODE_SMTP_PORT', emailCodeSmtpSecure ? 465 : 587),
    emailCodeSmtpSecure,
    emailCodeSmtpUser: readOptionalString('EMAIL_CODE_SMTP_USER'),
    emailCodeSmtpPassword: readOptionalString('EMAIL_CODE_SMTP_PASSWORD'),
    emailCodeSmtpTimeoutMilliseconds: readNumber('EMAIL_CODE_SMTP_TIMEOUT_MS', 10_000),
  };
}
