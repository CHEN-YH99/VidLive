import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConversionDraft } from '@vidlive/shared';
import { FfmpegService, type ProbeResult } from '../ffmpeg/ffmpeg.service.js';
import { createStoreZip } from './zip-writer.js';

export interface LivePhotoGenerateInput {
  sourcePath: string;
  workDir: string;
  draft: ConversionDraft;
}

export interface LivePhotoGenerateResult {
  photoPath: string;
  movPath: string;
  webpPath: string;
  zipPath: string;
  manifestPath: string;
  readmePath: string;
  contentId: string;
  probe: ProbeResult;
  warnings: string[];
}

const execFileAsync = promisify(execFile);

export class LivePhotoService {
  constructor(private readonly ffmpeg = new FfmpegService()) {}

  async generate(input: LivePhotoGenerateInput): Promise<LivePhotoGenerateResult> {
    await mkdir(input.workDir, { recursive: true });

    const warnings: string[] = [];
    const contentId = randomUUID().toUpperCase();
    const probe = await this.ffmpeg.probe(input.sourcePath);
    const startSeconds = clampNumber(input.draft.startSeconds, 0, Math.max(0, probe.durationSeconds - 1));
    const durationSeconds = clampNumber(input.draft.endSeconds - input.draft.startSeconds, 1, probe.durationSeconds);
    const keyframeSeconds = clampNumber(input.draft.keyframeSeconds, startSeconds, startSeconds + durationSeconds);
    const photoPath = path.join(input.workDir, 'photo.jpg');
    const movPath = path.join(input.workDir, 'video.mov');
    const webpPath = path.join(input.workDir, 'animated.webp');
    const manifestPath = path.join(input.workDir, 'manifest.json');
    const readmePath = path.join(input.workDir, 'README.txt');
    const zipPath = path.join(input.workDir, 'vidlive-phase0-livephoto-poc.zip');

    await this.ffmpeg.extractJpegFrame({
      inputPath: input.sourcePath,
      outputPath: photoPath,
      timestampSeconds: keyframeSeconds,
    });
    await this.ffmpeg.clipToMov({
      inputPath: input.sourcePath,
      outputPath: movPath,
      startSeconds,
      durationSeconds,
      muted: input.draft.muted,
      edit: input.draft,
    });
    await this.ffmpeg.clipToWebp({
      inputPath: input.sourcePath,
      outputPath: webpPath,
      startSeconds,
      durationSeconds,
      edit: input.draft,
    });

    await this.injectLivePhotoMetadata({
      photoPath,
      movPath,
      contentId,
      warnings,
    });

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          phase: 'Phase 0',
          purpose: 'Live Photo technical compatibility POC',
          contentId,
          sourcePath: input.sourcePath,
          draft: {
            ...input.draft,
            startSeconds,
            endSeconds: startSeconds + durationSeconds,
            keyframeSeconds,
          },
          probe,
          artifacts: {
            photo: 'photo.jpg',
            video: 'video.mov',
            webp: 'animated.webp',
            readme: 'README.txt',
          },
          warnings,
          nextVerification: [
            'AirDrop ZIP to iPhone and try importing files.',
            'Verify whether Photos recognizes the pair as Live Photo.',
            'Try iOS 17+ lock screen wallpaper with 1-2 second preset.',
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(readmePath, createReadme(contentId, warnings));
    await createStoreZip(
      [
        { sourcePath: photoPath, entryName: 'photo.jpg' },
        { sourcePath: movPath, entryName: 'video.mov' },
        { sourcePath: webpPath, entryName: 'animated.webp' },
        { sourcePath: manifestPath, entryName: 'manifest.json' },
        { sourcePath: readmePath, entryName: 'README.txt' },
      ],
      zipPath,
    );

    return {
      photoPath,
      movPath,
      webpPath,
      zipPath,
      manifestPath,
      readmePath,
      contentId,
      probe,
      warnings,
    };
  }

  private async injectLivePhotoMetadata(input: {
    photoPath: string;
    movPath: string;
    contentId: string;
    warnings: string[];
  }): Promise<void> {
    const exiftoolAvailable = await isCommandAvailable('exiftool', ['-ver']);

    if (!exiftoolAvailable) {
      input.warnings.push('exiftool-not-available: 已生成 MOV/JPEG/ZIP，但未完成 Apple Live Photo 元数据注入。');
      return;
    }

    try {
      await execFileAsync('exiftool', [
        '-overwrite_original',
        `-QuickTime:ContentIdentifier=${input.contentId}`,
        '-QuickTime:LivePhotoAuto=1',
        '-QuickTime:Make=Apple',
        input.movPath,
      ]);
      await execFileAsync('exiftool', [
        '-overwrite_original',
        `-XMP:ContentIdentifier=${input.contentId}`,
        input.photoPath,
      ]);
    } catch (error) {
      input.warnings.push(
        `exiftool-metadata-failed: ${error instanceof Error ? error.message : 'Unknown exiftool error'}`,
      );
    }
  }
}

async function isCommandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function createReadme(contentId: string, warnings: string[]): string {
  const warningText = warnings.length > 0 ? warnings.map((warning) => `- ${warning}`).join('\n') : '- 暂无。';

  return [
    'VidLive Phase 0 Live Photo POC',
    '',
    `Content Identifier: ${contentId}`,
    '',
    'Artifacts:',
    '- photo.jpg: extracted key frame',
    '- video.mov: H.264 MOV clip',
    '- animated.webp: WebP fallback export',
    '- manifest.json: generation parameters and probe result',
    '',
    'Manual verification:',
    '1. Transfer this ZIP to iPhone by AirDrop or Files.',
    '2. Import photo.jpg and video.mov using the selected save path.',
    '3. Check Photos Live Photo recognition.',
    '4. Set as iOS 17+ lock screen wallpaper and record playback result.',
    '',
    'Warnings:',
    warningText,
  ].join('\n');
}
