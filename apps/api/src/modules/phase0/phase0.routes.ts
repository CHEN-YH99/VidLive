import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  exportPresets,
  phaseZeroExitCriteria,
  phaseZeroModules,
  productLimits,
  savePathSteps,
  supportedInputs,
  type AspectRatioId,
  type ConversionDraft,
  type ExportPresetId,
  type FitMode,
} from '@vidlive/shared';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { LivePhotoService } from '../../services/live-photo/live-photo.service.js';

interface CommandStatus {
  name: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

interface PhaseZeroPocQuery {
  presetId?: ExportPresetId;
  startSeconds?: string;
  endSeconds?: string;
  keyframeSeconds?: string;
  muted?: string;
  aspectRatioId?: AspectRatioId;
  fitMode?: FitMode;
  rotationDegrees?: string;
  flipHorizontal?: string;
  flipVertical?: string;
  brightness?: string;
  contrast?: string;
  saturation?: string;
}

const execFileAsync = promisify(execFile);

export function registerPhaseZeroRoutes(server: FastifyInstance, config: AppConfig): void {
  const livePhotoService = new LivePhotoService();

  server.get('/api/phase0/environment', async () => {
    const tools = await Promise.all([
      checkCommand('ffmpeg', ['-version']),
      checkCommand('ffprobe', ['-version']),
      checkCommand('exiftool', ['-ver']),
    ]);

    return {
      phase: 'android-motion-photo-validation',
      timestamp: new Date().toISOString(),
      verdict: {
        ffmpegReady: tools.some((tool) => tool.name === 'ffmpeg' && tool.available),
        ffprobeReady: tools.some((tool) => tool.name === 'ffprobe' && tool.available),
        metadataReady: tools.some((tool) => tool.name === 'exiftool' && tool.available),
      },
      tools,
      limits: {
        localFileSizeBytes: config.localFileSizeBytes,
        cloudFileSizeBytes: config.cloudFileSizeBytes,
      },
      note: 'exiftool 缺失时仍可生成 MOV/JPEG/ZIP，但不能完成 Apple Live Photo 元数据注入。',
    };
  });

  server.get('/api/phase0/checklist', async () => {
    return {
      phase: 'android-motion-photo-validation',
      modules: phaseZeroModules,
      savePathSteps,
      exitCriteria: phaseZeroExitCriteria,
      supportedInputs,
      productLimits,
      presets: Object.values(exportPresets),
    };
  });

  server.post<{ Querystring: PhaseZeroPocQuery }>('/api/phase0/live-photo-poc', async (request, reply) => {
    const upload = await request.file();

    if (!upload) {
      return reply.status(400).send({
        code: 'file-required',
        message: '安卓实况图生成需要上传一个 MP4 或 MOV 文件。',
      });
    }

    if (!isSupportedUpload(upload.filename, upload.mimetype)) {
      return reply.status(415).send({
        code: 'unsupported-format',
        message: '仅支持 MP4 和 MOV 格式。',
      });
    }

    const workId = createWorkId();
    const workDir = path.resolve(config.uploadDir, 'phase0', workId);
    await mkdir(workDir, { recursive: true });

    const extension = path.extname(upload.filename) || '.mp4';
    const sourcePath = path.join(workDir, `source${extension}`);
    await pipeline(upload.file, createWriteStream(sourcePath));

    const draft = createDraftFromQuery(request.query);
    const result = await livePhotoService.generate({
      sourcePath,
      workDir,
      draft,
    });

    return {
      phase: 'android-motion-photo-validation',
      id: workId,
      status: 'generated',
      artifacts: {
        photoPath: result.photoPath,
        movPath: result.movPath,
        zipPath: result.zipPath,
        manifestPath: result.manifestPath,
        readmePath: result.readmePath,
      },
      contentId: result.contentId,
      probe: result.probe,
      warnings: result.warnings,
      manualVerification: [
        '将 motion-photo_MP.jpg 传输到安卓设备。',
        '优先使用 Google Photos 或抖音打开。',
        '记录查看器是否出现动态照片播放入口。',
        '若系统相册只显示静态图，请按兼容限制记录。',
      ],
    };
  });
}

async function checkCommand(name: string, args: string[]): Promise<CommandStatus> {
  try {
    const { stdout, stderr } = await execFileAsync(name, args, {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = [stdout, stderr].join('\n').trim();
    const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0) ?? null;

    return {
      name,
      available: true,
      version: firstLine,
      error: null,
    };
  } catch (error) {
    return {
      name,
      available: false,
      version: null,
      error: error instanceof Error ? error.message : 'Unknown command error',
    };
  }
}

function createDraftFromQuery(query: PhaseZeroPocQuery): ConversionDraft {
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

  return {
    mode: 'cloud',
    presetId,
    aspectRatioId: query.aspectRatioId ?? preset.preferredAspectRatio,
    fitMode: query.fitMode ?? 'cover',
    backgroundColor: '#111827',
    rotationDegrees: readRotation(query.rotationDegrees),
    flipHorizontal: query.flipHorizontal === 'true',
    flipVertical: query.flipVertical === 'true',
    brightness: readNumber(query.brightness, 100),
    contrast: readNumber(query.contrast, 100),
    saturation: readNumber(query.saturation, 100),
    startSeconds,
    endSeconds,
    keyframeSeconds,
    muted: query.muted !== 'false',
  };
}

function readRotation(value: string | undefined): 0 | 90 | 180 | 270 {
  const parsed = Number(value);

  return parsed === 90 || parsed === 180 || parsed === 270 ? parsed : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function isSupportedUpload(filename: string, mimeType: string): boolean {
  const extension = path.extname(filename).replace('.', '').toLowerCase();

  return supportedInputs.some((input) => {
    if (input.extension === 'gif') {
      return false;
    }

    return input.extension === extension || (input.mimeTypes as readonly string[]).includes(mimeType);
  });
}

function createWorkId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
