import {
  aspectRatios,
  exportPresets,
  failureAdvice,
  productLimits,
  supportedInputs,
  type AspectRatioId,
  type ConversionDraft,
  type ExportPresetId,
  type FitMode,
} from '@vidlive/shared';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { ConversionService } from './conversion.service.js';

interface CloudJobQuery {
  presetId?: ExportPresetId;
  aspectRatioId?: AspectRatioId;
  fitMode?: FitMode;
  backgroundColor?: string;
  startSeconds?: string;
  endSeconds?: string;
  keyframeSeconds?: string;
  muted?: string;
  rotationDegrees?: string;
  flipHorizontal?: string;
  flipVertical?: string;
  brightness?: string;
  contrast?: string;
  saturation?: string;
}

interface CloudJobParams {
  jobId: string;
}

export function registerConversionRoutes(server: FastifyInstance, config: AppConfig): void {
  const conversionService = new ConversionService({
    config,
    logger: server.log,
  });

  server.addHook('onClose', async () => {
    await conversionService.close();
  });

  server.get('/api/conversions/capabilities', async () => {
    return {
      modes: ['local', 'cloud'],
      supportedInputs,
      productLimits: {
        ...productLimits,
        localFileSizeBytes: config.localFileSizeBytes,
        cloudFileSizeBytes: config.cloudFileSizeBytes,
      },
      presets: Object.values(exportPresets),
      aspectRatios,
      failureAdvice: Object.values(failureAdvice),
      beta: {
        cloudJobsEndpoint: '/api/conversions/cloud-jobs',
        queue: {
          provider: conversionService.queueProvider,
          retryable: true,
          worker: conversionService.queueProvider === 'redis-bullmq' ? 'BullMQ Worker' : 'in-process fallback',
          statusEndpoint: '/api/conversions/cloud-jobs/:jobId',
        },
        storage: {
          provider: conversionService.storageProvider,
          retentionHours: config.cloudRetentionHours,
          r2Ready: conversionService.storageProvider === 'r2-signed-url',
        },
        metricsEndpoint: '/api/conversions/metrics',
      },
    };
  });

  server.get('/api/conversions/metrics', async () => {
    return conversionService.getMetrics();
  });

  server.post('/api/conversions/cloud-intents', async () => {
    return {
      code: 'cloud-processing-enabled',
      message: '云端处理已可用于安卓实况图生成。',
      uploadPolicy: {
        requiresConsent: true,
        defaultRetentionHours: config.cloudRetentionHours,
        maxFileSizeBytes: config.cloudFileSizeBytes,
      },
      endpoints: {
        createJob: '/api/conversions/cloud-jobs',
        getJob: '/api/conversions/cloud-jobs/:jobId',
        download: '/api/conversions/cloud-jobs/:jobId/download',
        androidMotionPhoto: '/api/conversions/cloud-jobs/:jobId/android-motion-photo',
        delete: '/api/conversions/cloud-jobs/:jobId',
      },
    };
  });

  server.post<{ Querystring: CloudJobQuery }>('/api/conversions/cloud-jobs', async (request, reply) => {
    const upload = await request.file();

    if (!upload) {
      return reply.status(400).send({
        code: 'missing-file',
        message: '云端生成需要上传一个 MP4、MOV 或 GIF 文件。',
      });
    }

    if (!isSupportedUpload(upload.filename, upload.mimetype)) {
      return reply.status(415).send({
        code: 'unsupported-format',
        message: '仅支持 MP4、MOV 和 GIF 格式。',
      });
    }

    const jobId = randomUUID();
    const workDir = path.resolve(config.uploadDir, 'conversions', jobId);
    const extension = path.extname(upload.filename) || extensionFromMime(upload.mimetype);
    const sourcePath = path.join(workDir, `source${extension}`);

    await mkdir(workDir, { recursive: true });
    await pipeline(upload.file, createWriteStream(sourcePath));

    const sourceStat = await stat(sourcePath);

    if (sourceStat.size > config.cloudFileSizeBytes) {
      return reply.status(413).send({
        code: 'file-too-large',
        message: '上传文件超过云端处理大小限制。',
        maxFileSizeBytes: config.cloudFileSizeBytes,
      });
    }

    const job = await conversionService.createCloudJob({
      id: jobId,
      sourcePath,
      workDir,
      fileName: upload.filename,
      mimeType: upload.mimetype,
      sizeBytes: sourceStat.size,
      draft: createDraftFromQuery(request.query),
      retentionHours: config.cloudRetentionHours,
    });

    return reply.status(202).send(job);
  });

  server.get<{ Params: CloudJobParams }>('/api/conversions/cloud-jobs/:jobId', async (request, reply) => {
    const job = await conversionService.getCloudJob(request.params.jobId);

    if (!job) {
      return reply.status(404).send({
        code: 'conversion-job-not-found',
        message: '未找到云端生成任务，或任务已被删除。',
      });
    }

    return job;
  });

  server.get<{ Params: CloudJobParams }>('/api/conversions/cloud-jobs/:jobId/download', async (request, reply) => {
    const download = await conversionService.getDownload(request.params.jobId);

    if (!download) {
      return reply.status(404).send({
        code: 'download-not-ready',
        message: '云端导出包尚未生成、已过期或已删除。',
      });
    }

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Length', download.sizeBytes.toString());
    reply.header('Content-Disposition', `attachment; filename="${download.fileName}"`);

    return reply.send(createReadStream(download.path));
  });

  server.get<{ Params: CloudJobParams }>('/api/conversions/cloud-jobs/:jobId/android-motion-photo', async (request, reply) => {
    const download = await conversionService.getAndroidMotionPhotoDownload(request.params.jobId);

    if (!download) {
      return reply.status(404).send({
        code: 'android-motion-photo-not-ready',
        message: '安卓实况图尚未生成、已过期或已删除。',
      });
    }

    reply.header('Content-Type', 'image/jpeg');
    reply.header('Content-Length', download.sizeBytes.toString());
    reply.header('Content-Disposition', `attachment; filename="${download.fileName}"`);

    return reply.send(createReadStream(download.path));
  });

  server.get<{ Params: CloudJobParams }>('/api/conversions/cloud-jobs/:jobId/preview-photo', async (request, reply) => {
    const download = await conversionService.getPreviewPhotoDownload(request.params.jobId);

    if (!download) {
      return reply.status(404).send({
        code: 'preview-photo-not-ready',
        message: '预览图尚未生成、已过期或已删除。',
      });
    }

    reply.header('Content-Type', 'image/jpeg');
    reply.header('Content-Length', download.sizeBytes.toString());
    reply.header('Content-Disposition', `inline; filename="${download.fileName}"`);

    return reply.send(createReadStream(download.path));
  });

  server.get<{ Params: CloudJobParams }>('/api/conversions/cloud-jobs/:jobId/paired-video', async (request, reply) => {
    const download = await conversionService.getPairedVideoDownload(request.params.jobId);

    if (!download) {
      return reply.status(404).send({
        code: 'paired-video-not-ready',
        message: '配套动态片段尚未生成、已过期或已删除。',
      });
    }

    reply.header('Content-Type', 'video/quicktime');
    reply.header('Content-Length', download.sizeBytes.toString());
    reply.header('Content-Disposition', `attachment; filename="${download.fileName}"`);

    return reply.send(createReadStream(download.path));
  });

  server.delete<{ Params: CloudJobParams }>('/api/conversions/cloud-jobs/:jobId', async (request, reply) => {
    const job = await conversionService.deleteCloudJob(request.params.jobId);

    if (!job) {
      return reply.status(404).send({
        code: 'conversion-job-not-found',
        message: '云端生成任务不存在，或已被删除。',
      });
    }

    return {
      ...job,
      deleted: true,
    };
  });
}

function createDraftFromQuery(query: CloudJobQuery): ConversionDraft {
  const presetId = query.presetId && query.presetId in exportPresets ? query.presetId : 'standard-live-photo';
  const preset = exportPresets[presetId];
  const startSeconds = Math.max(0, readNumber(query.startSeconds, 0));
  const maxEndSeconds = startSeconds + preset.maxDurationSeconds;
  const endSeconds = clampNumber(
    readNumber(query.endSeconds, startSeconds + preset.defaultDurationSeconds),
    startSeconds + productLimits.minDurationSeconds,
    maxEndSeconds,
  );
  const keyframeSeconds = clampNumber(
    readNumber(query.keyframeSeconds, startSeconds + (endSeconds - startSeconds) / 2),
    startSeconds,
    endSeconds,
  );
  const aspectRatioId = aspectRatios.some((ratio) => ratio.id === query.aspectRatioId)
    ? query.aspectRatioId!
    : preset.preferredAspectRatio;
  const fitMode = query.fitMode === 'contain' ? 'contain' : 'cover';

  return {
    mode: 'cloud',
    presetId,
    aspectRatioId,
    fitMode,
    backgroundColor: readBackgroundColor(query.backgroundColor),
    rotationDegrees: readRotation(query.rotationDegrees),
    flipHorizontal: query.flipHorizontal === 'true',
    flipVertical: query.flipVertical === 'true',
    brightness: readNumber(query.brightness, 100),
    contrast: readNumber(query.contrast, 100),
    saturation: readNumber(query.saturation, 100),
    startSeconds,
    endSeconds,
    clipDurationSeconds: endSeconds - startSeconds,
    keyframeSeconds,
    muted: query.muted !== 'false',
  };
}

function readBackgroundColor(value: string | undefined): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : '#111827';
}

function readRotation(value: string | undefined): 0 | 90 | 180 | 270 {
  const parsed = Number(value);

  return parsed === 90 || parsed === 180 || parsed === 270 ? parsed : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function isSupportedUpload(fileName: string, mimeType: string): boolean {
  const normalizedName = fileName.toLowerCase();
  const normalizedMime = mimeType.toLowerCase();

  return supportedInputs.some((input) => {
    return normalizedName.endsWith(`.${input.extension}`) || input.mimeTypes.some((item) => item === normalizedMime);
  });
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes('quicktime')) {
    return '.mov';
  }

  if (mimeType.includes('gif')) {
    return '.gif';
  }

  return '.mp4';
}
