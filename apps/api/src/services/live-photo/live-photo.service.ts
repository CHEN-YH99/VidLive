import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConversionDraft } from '@vidlive/shared';
import { FfmpegService, type ProbeResult } from '../ffmpeg/ffmpeg.service.js';
import {
  AndroidMotionPhotoService,
  type AndroidMotionPhotoResult,
} from '../motion-photo/android-motion-photo.service.js';
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
  androidMotionPhotoPath: string | null;
  androidMotionPhoto: AndroidMotionPhotoResult | null;
  contentId: string;
  metadataInjected: boolean;
  metadataInjection: LivePhotoMetadataInjectionReport;
  probe: ProbeResult;
  warnings: string[];
}

export interface LivePhotoMetadataInjectionReport {
  videoContentIdentifierInjected: boolean;
  photoMakerNoteTemplateApplied: boolean;
  photoContentIdentifierInjected: boolean;
  photoImageUniqueIdInjected: boolean;
}

const execFileAsync = promisify(execFile);

export class LivePhotoService {
  constructor(
    private readonly ffmpeg = new FfmpegService(),
    private readonly androidMotionPhoto = new AndroidMotionPhotoService(),
  ) {}

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
    const androidVideoPath = path.join(input.workDir, 'motion-video.mp4');
    const androidMotionPhotoPath = path.join(input.workDir, 'motion-photo_MP.jpg');

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
    await this.ffmpeg.clipToMp4({
      inputPath: input.sourcePath,
      outputPath: androidVideoPath,
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

    let androidMotionPhoto: AndroidMotionPhotoResult | null = null;

    try {
      androidMotionPhoto = await this.androidMotionPhoto.generate({
        photoPath,
        videoPath: androidVideoPath,
        outputPath: androidMotionPhotoPath,
        presentationTimestampUs: Math.round((keyframeSeconds - startSeconds) * 1_000_000),
      });
    } catch (error) {
      warnings.push(
        `android-motion-photo-failed: ${error instanceof Error ? error.message : 'Unknown Android Motion Photo error'}`,
      );
    }

    const metadataInjection = await this.injectLivePhotoMetadata({
      photoPath,
      movPath,
      contentId,
      warnings,
    });
    const metadataInjected =
      metadataInjection.videoContentIdentifierInjected && metadataInjection.photoContentIdentifierInjected;

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          phase: 'Phase 0',
          purpose: 'Live Photo technical compatibility POC',
          contentId,
          metadataInjected,
          metadataInjection,
          livePhotoRecognition: metadataInjected
            ? 'metadata-injected-import-still-requires-device-verification'
            : 'not-ready-metadata-injection-missing',
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
            androidMotionPhoto: androidMotionPhoto ? 'motion-photo_MP.jpg' : null,
            readme: 'README.txt',
          },
          androidMotionPhoto: androidMotionPhoto
            ? {
                fileName: 'motion-photo_MP.jpg',
                videoLengthBytes: androidMotionPhoto.videoLengthBytes,
                xmpInjected: androidMotionPhoto.xmpInjected,
                expectedAndroidViewer: 'Google Photos or OEM gallery with Motion Photo support',
              }
            : null,
          warnings,
          nextVerification: [
            'AirDrop ZIP to iPhone and try importing files.',
            'Verify whether Photos recognizes the pair as Live Photo.',
            'Safari ZIP download alone is expected to stay as files, not a Photos Live Photo asset.',
            'Copy motion-photo_MP.jpg to Android and open it in Google Photos or an OEM gallery.',
            'Try iOS 17+ lock screen wallpaper with 1-2 second preset.',
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(readmePath, createReadme(contentId, metadataInjected, metadataInjection, warnings));
    const zipEntries = [
      { sourcePath: photoPath, entryName: 'photo.jpg' },
      { sourcePath: movPath, entryName: 'video.mov' },
      { sourcePath: webpPath, entryName: 'animated.webp' },
      { sourcePath: manifestPath, entryName: 'manifest.json' },
      { sourcePath: readmePath, entryName: 'README.txt' },
    ];

    if (androidMotionPhoto) {
      zipEntries.splice(3, 0, { sourcePath: androidMotionPhoto.path, entryName: 'motion-photo_MP.jpg' });
    }

    await createStoreZip(zipEntries, zipPath);

    return {
      photoPath,
      movPath,
      webpPath,
      zipPath,
      manifestPath,
      readmePath,
      androidMotionPhotoPath: androidMotionPhoto?.path ?? null,
      androidMotionPhoto,
      contentId,
      metadataInjected,
      metadataInjection,
      probe,
      warnings,
    };
  }

  private async injectLivePhotoMetadata(input: {
    photoPath: string;
    movPath: string;
    contentId: string;
    warnings: string[];
  }): Promise<LivePhotoMetadataInjectionReport> {
    const report: LivePhotoMetadataInjectionReport = {
      videoContentIdentifierInjected: false,
      photoMakerNoteTemplateApplied: false,
      photoContentIdentifierInjected: false,
      photoImageUniqueIdInjected: false,
    };
    const exiftoolAvailable = await isCommandAvailable('exiftool', ['-ver']);

    if (!exiftoolAvailable) {
      input.warnings.push('exiftool-not-available: 已生成 MOV/JPEG/ZIP，但未完成 Apple Live Photo 元数据注入。');
      return report;
    }

    try {
      await execFileAsync('exiftool', [
        '-overwrite_original',
        `-QuickTime:ContentIdentifier=${input.contentId}`,
        '-QuickTime:LivePhotoAuto=1',
        '-QuickTime:Make=Apple',
        input.movPath,
      ]);
      report.videoContentIdentifierInjected = await exifOutputContains(
        input.movPath,
        ['-ContentIdentifier'],
        input.contentId,
      );

      if (!report.videoContentIdentifierInjected) {
        input.warnings.push('mov-content-identifier-missing: MOV 未读回匹配的 ContentIdentifier。');
      }
    } catch (error) {
      input.warnings.push(
        `mov-metadata-failed: ${error instanceof Error ? error.message : 'Unknown exiftool error'}`,
      );
    }

    try {
      report.photoMakerNoteTemplateApplied = await this.applyPhotoMakerNoteTemplate(input.photoPath, input.warnings);
      await execFileAsync('exiftool', [
        '-overwrite_original',
        `-ContentIdentifier=${input.contentId}`,
        `-ImageUniqueID=${input.contentId}`,
        input.photoPath,
      ]);
      report.photoContentIdentifierInjected = await exifOutputContains(
        input.photoPath,
        ['-ContentIdentifier'],
        input.contentId,
      );
      report.photoImageUniqueIdInjected = await exifOutputContains(
        input.photoPath,
        ['-ImageUniqueID'],
        input.contentId,
      );

      if (!report.photoContentIdentifierInjected) {
        const warning = report.photoMakerNoteTemplateApplied
          ? 'photo-content-identifier-missing: 已复制原生照片 MakerNotes，但照片仍未读回匹配的 Apple ContentIdentifier。'
          : 'photo-maker-note-template-missing: FFmpeg 生成的 JPEG 没有 Apple MakerNote ContentIdentifier；请配置 LIVE_PHOTO_TEMPLATE_IMAGE_PATH 指向 iPhone 原生 Live Photo 静态图模板。';

        input.warnings.push(warning);
      }
    } catch (error) {
      input.warnings.push(
        `photo-metadata-failed: ${error instanceof Error ? error.message : 'Unknown exiftool error'}`,
      );
    }

    return report;
  }

  private async applyPhotoMakerNoteTemplate(photoPath: string, warnings: string[]): Promise<boolean> {
    const templatePath = process.env.LIVE_PHOTO_TEMPLATE_IMAGE_PATH?.trim();

    if (!templatePath) {
      return false;
    }

    try {
      await execFileAsync('exiftool', [
        '-overwrite_original',
        '-TagsFromFile',
        templatePath,
        '-Make',
        '-Model',
        '-MakerNotes',
        photoPath,
      ]);

      return true;
    } catch (error) {
      warnings.push(
        `photo-maker-note-template-failed: ${error instanceof Error ? error.message : 'Unknown exiftool error'}`,
      );
      return false;
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

async function exifOutputContains(filePath: string, tags: string[], expectedValue: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('exiftool', ['-a', '-G1', '-s', ...tags, filePath], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    return stdout.includes(expectedValue);
  } catch {
    return false;
  }
}

function createReadme(
  contentId: string,
  metadataInjected: boolean,
  metadataInjection: LivePhotoMetadataInjectionReport,
  warnings: string[],
): string {
  const warningText = warnings.length > 0 ? warnings.map((warning) => `- ${warning}`).join('\n') : '- 暂无。';

  return [
    'VidLive Phase 0 Live Photo POC',
    '',
    `Content Identifier: ${contentId}`,
    `Metadata Injected: ${metadataInjected ? 'yes' : 'no'}`,
    `MOV Content Identifier: ${metadataInjection.videoContentIdentifierInjected ? 'yes' : 'no'}`,
    `Photo MakerNote Template: ${metadataInjection.photoMakerNoteTemplateApplied ? 'yes' : 'no'}`,
    `Photo Content Identifier: ${metadataInjection.photoContentIdentifierInjected ? 'yes' : 'no'}`,
    `Photo ImageUniqueID: ${metadataInjection.photoImageUniqueIdInjected ? 'yes' : 'no'}`,
    '',
    'Important:',
    '- This ZIP is a paired media package, not a file that iPhone Safari can directly save as a Photos Live Photo.',
    '- Photos recognition still depends on the import path and must be verified on real devices.',
    '',
    'Artifacts:',
    '- photo.jpg: extracted key frame',
    '- video.mov: H.264 MOV clip',
    '- motion-photo_MP.jpg: Android Motion Photo single-file experiment',
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
