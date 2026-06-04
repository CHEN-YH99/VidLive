import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AspectRatioId, FitMode } from '@vidlive/shared';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
}

export interface ClipOptions {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  muted: boolean;
  edit?: {
    aspectRatioId?: AspectRatioId;
    fitMode?: FitMode;
    backgroundColor?: string;
    rotationDegrees?: number;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
    brightness?: number;
    contrast?: number;
    saturation?: number;
  };
}

export interface WebpOptions {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  edit?: ClipOptions['edit'];
}

export interface FrameOptions {
  inputPath: string;
  outputPath: string;
  timestampSeconds: number;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
  };
}

const execFileAsync = promisify(execFile);

export class FfmpegService {
  async probe(filePath: string): Promise<ProbeResult> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      filePath,
    ]);
    const output = JSON.parse(stdout) as FfprobeOutput;
    const streams = output.streams ?? [];
    const videoStream = streams.find((stream) => stream.codec_type === 'video');

    if (!videoStream) {
      throw new Error('ffprobe-video-stream-not-found');
    }

    return {
      durationSeconds: parsePositiveNumber(videoStream.duration ?? output.format?.duration, 0),
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
      hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    };
  }

  async clipToMov(options: ClipOptions): Promise<string> {
    await mkdir(path.dirname(options.outputPath), { recursive: true });

    const args = [
      '-y',
      '-ss',
      options.startSeconds.toString(),
      '-i',
      options.inputPath,
      '-t',
      options.durationSeconds.toString(),
      '-map',
      '0:v:0',
    ];
    const videoFilters = createVideoFilters(options.edit);

    if (videoFilters.length > 0) {
      args.push('-vf', videoFilters.join(','));
    }

    args.push(
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-movflags',
      '+faststart',
    );

    if (options.muted) {
      args.push('-an');
    } else {
      args.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100');
    }

    args.push(options.outputPath);

    await execFileAsync('ffmpeg', args, {
      maxBuffer: 10 * 1024 * 1024,
    });

    return options.outputPath;
  }

  async clipToWebp(options: WebpOptions): Promise<string> {
    await mkdir(path.dirname(options.outputPath), { recursive: true });

    const args = [
      '-y',
      '-ss',
      options.startSeconds.toString(),
      '-i',
      options.inputPath,
      '-t',
      options.durationSeconds.toString(),
      '-map',
      '0:v:0',
    ];
    const videoFilters = [...createVideoFilters(options.edit), 'fps=15'];

    args.push(
      '-vf',
      videoFilters.join(','),
      '-loop',
      '0',
      '-c:v',
      'libwebp',
      '-quality',
      '82',
      '-preset',
      'picture',
      options.outputPath,
    );

    await execFileAsync('ffmpeg', args, {
      maxBuffer: 10 * 1024 * 1024,
    });

    return options.outputPath;
  }

  async extractJpegFrame(options: FrameOptions): Promise<string> {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        options.timestampSeconds.toString(),
        '-i',
        options.inputPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        options.outputPath,
      ],
      {
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return options.outputPath;
  }
}

function createVideoFilters(edit: ClipOptions['edit']): string[] {
  if (!edit) {
    return [];
  }

  const filters: string[] = [];
  const rotation = normalizeRotation(edit.rotationDegrees ?? 0);

  if (rotation === 90) {
    filters.push('transpose=1');
  } else if (rotation === 270) {
    filters.push('transpose=2');
  } else if (rotation === 180) {
    filters.push('hflip', 'vflip');
  }

  if (edit.flipHorizontal) {
    filters.push('hflip');
  }

  if (edit.flipVertical) {
    filters.push('vflip');
  }

  if ((edit.brightness ?? 100) !== 100 || (edit.contrast ?? 100) !== 100 || (edit.saturation ?? 100) !== 100) {
    const brightness = ((clampNumber(edit.brightness ?? 100, 50, 150) - 100) / 100).toFixed(2);
    const contrast = (clampNumber(edit.contrast ?? 100, 50, 150) / 100).toFixed(2);
    const saturation = (clampNumber(edit.saturation ?? 100, 0, 200) / 100).toFixed(2);
    filters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
  }

  const targetSize = resolveTargetSize(edit.aspectRatioId);

  if (targetSize) {
    if (edit.fitMode === 'contain') {
      filters.push(
        `scale=${targetSize.width}:${targetSize.height}:force_original_aspect_ratio=decrease`,
        `pad=${targetSize.width}:${targetSize.height}:(ow-iw)/2:(oh-ih)/2:color=${toFfmpegColor(edit.backgroundColor)}`,
      );
    } else {
      filters.push(
        `scale=${targetSize.width}:${targetSize.height}:force_original_aspect_ratio=increase`,
        `crop=${targetSize.width}:${targetSize.height}`,
      );
    }
  } else {
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }

  return filters;
}

function resolveTargetSize(aspectRatioId: AspectRatioId | undefined): { width: number; height: number } | null {
  if (aspectRatioId === '9:16') {
    return { width: 720, height: 1280 };
  }

  if (aspectRatioId === '1:1') {
    return { width: 720, height: 720 };
  }

  if (aspectRatioId === '4:5') {
    return { width: 720, height: 900 };
  }

  if (aspectRatioId === '16:9') {
    return { width: 1280, height: 720 };
  }

  return null;
}

function toFfmpegColor(value: string | undefined): string {
  const normalized = /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : '#111827';

  return `0x${normalized.slice(1)}`;
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;

  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value || value === '0/0') {
    return null;
  }

  const [numeratorRaw, denominatorRaw] = value.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}
