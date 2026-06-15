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
    const iosWarnings: string[] = [];
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
    const androidPhotoPath = path.join(input.workDir, 'motion-photo.jpg');
    const androidVideoPath = path.join(input.workDir, 'motion-video.mp4');
    const androidMotionPhotoPath = path.join(input.workDir, 'motion-photo_MP.jpg');
    const androidDraft = createAndroidMotionPhotoDraft(input.draft);
    const androidKeyframeSeconds = keyframeSeconds - startSeconds;

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
      edit: androidDraft,
    });
    await this.ffmpeg.extractJpegFrame({
      inputPath: androidVideoPath,
      outputPath: androidPhotoPath,
      timestampSeconds: androidKeyframeSeconds,
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
        photoPath: androidPhotoPath,
        videoPath: androidVideoPath,
        outputPath: androidMotionPhotoPath,
        presentationTimestampUs: Math.round(androidKeyframeSeconds * 1_000_000),
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
      warnings: iosWarnings,
    });
    const metadataInjected =
      metadataInjection.videoContentIdentifierInjected && metadataInjection.photoContentIdentifierInjected;
    const androidMotionPhotoReady = androidMotionPhoto !== null && androidMotionPhoto.xmpInjected;

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          phase: 'android-motion-photo-validation',
          purpose: 'Android Motion Photo generation',
          primaryTarget: 'android-motion-photo',
          contentId,
          metadataInjected,
          metadataInjection,
          livePhotoRecognition: androidMotionPhotoReady
            ? 'android-motion-photo-generated'
            : 'android-motion-photo-not-generated',
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
                status: 'generated',
                videoLengthBytes: androidMotionPhoto.videoLengthBytes,
                xmpInjected: androidMotionPhoto.xmpInjected,
                aspectRatioId: androidDraft.aspectRatioId,
                fitMode: androidDraft.fitMode,
                expectedAndroidViewer:
                  'Google Photos or Douyin verified; ColorOS/HarmonyOS system galleries may show a still image.',
              }
            : null,
          iosLivePhoto: {
            status: 'deferred',
            note: 'Apple Live Photo pairing is not the current release target.',
            metadataInjected,
            metadataInjection,
            recognition: metadataInjected
              ? 'metadata-injected-import-still-requires-device-verification'
              : 'not-targeted-for-current-android-release',
            warnings: iosWarnings,
          },
          warnings,
          nextVerification: [
            '将 motion-photo_MP.jpg 复制到安卓设备，并优先使用 Google Photos 或抖音打开。',
            '确认查看器出现 Motion Photo 或动态照片播放入口。',
            '如果 ColorOS / HarmonyOS 系统相册只显示静态图，请按查看器兼容限制记录。',
            'ZIP 主要用于桌面传输、归档和兼容复测。',
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      readmePath,
      createReadme(contentId, androidMotionPhoto, metadataInjected, metadataInjection, warnings, iosWarnings),
    );
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
      ], {
        timeout: 30000, // P0-7: exiftool 超时 30 秒
        maxBuffer: 2 * 1024 * 1024,
      });
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
      ], {
        timeout: 30000, // P0-7: exiftool 超时 30 秒
        maxBuffer: 2 * 1024 * 1024,
      });
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
      ], {
        timeout: 30000, // P0-7: exiftool 超时 30 秒
        maxBuffer: 2 * 1024 * 1024,
      });

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
    await execFileAsync(command, args, {
      timeout: 10000, // P0-7: 命令检测超时 10 秒
    });
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
  androidMotionPhoto: AndroidMotionPhotoResult | null,
  metadataInjected: boolean,
  metadataInjection: LivePhotoMetadataInjectionReport,
  warnings: string[],
  iosWarnings: string[],
): string {
  const warningText = warnings.length > 0 ? warnings.map((warning) => `- ${warning}`).join('\n') : '- 暂无。';
  const iosWarningText =
    iosWarnings.length > 0 ? iosWarnings.map((warning) => `- ${warning}`).join('\n') : '- 暂无。';

  return [
    'VidLive Android Motion Photo 生成包',
    '',
    `安卓实况图：${androidMotionPhoto ? '已生成' : '未生成'}`,
    '主文件：motion-photo_MP.jpg',
    `内容标识：${contentId}`,
    '',
    '重要说明：',
    '- motion-photo_MP.jpg 是安卓实况图主产物，请优先使用 Google Photos 或抖音打开验证。',
    '- 即使 Google Photos 或抖音可识别动态内容，ColorOS / HarmonyOS 系统相册仍可能只显示静态图。',
    '- Motion Photo 识别依赖具体安卓查看器，最终结果以真机验证为准。',
    '- Apple Live Photo 配对不是当前安卓实况图链路的验收标准。',
    '',
    '导出文件：',
    '- motion-photo_MP.jpg：安卓实况图单文件',
    '- photo.jpg：关键帧封面',
    '- video.mov：H.264 MOV 动态片段',
    '- animated.webp：WebP 通用预览',
    '- manifest.json：生成参数和探测结果',
    '',
    '真机验证：',
    '1. 将 motion-photo_MP.jpg 下载或复制到安卓设备。',
    '2. 优先使用 Google Photos 或抖音打开。',
    '3. 确认查看器出现 Motion Photo 或动态照片播放入口。',
    '4. 如果 ColorOS / HarmonyOS 系统相册只显示静态图，请按兼容限制记录。',
    '5. ZIP 主要用于桌面传输、归档和兼容复测。',
    '',
    '提示：',
    warningText,
    '',
    'iOS Live Photo 元数据状态：',
    `元数据注入：${metadataInjected ? '是' : '否'}`,
    `MOV 内容标识：${metadataInjection.videoContentIdentifierInjected ? '是' : '否'}`,
    `Photo MakerNote 模板：${metadataInjection.photoMakerNoteTemplateApplied ? '是' : '否'}`,
    `Photo 内容标识：${metadataInjection.photoContentIdentifierInjected ? '是' : '否'}`,
    `Photo ImageUniqueID：${metadataInjection.photoImageUniqueIdInjected ? '是' : '否'}`,
    '',
    'iOS 元数据提示：',
    iosWarningText,
  ].join('\n');
}

function createAndroidMotionPhotoDraft(draft: ConversionDraft): ConversionDraft {
  return draft;
}
