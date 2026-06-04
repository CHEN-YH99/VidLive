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
  };
}
