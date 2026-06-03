import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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
    ];

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
