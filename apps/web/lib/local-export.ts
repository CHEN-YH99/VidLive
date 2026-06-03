import {
  aspectRatios,
  exportPresets,
  productLimits,
  type AspectRatioId,
  type ConversionDraft,
  type FitMode,
  type VideoMetadata,
} from '@vidlive/shared';
import { captureCoverFrame } from '@/lib/file-inspector';

export type ArtifactKind = 'package' | 'cover' | 'clip' | 'manifest' | 'source';

export interface LocalExportArtifact {
  id: string;
  kind: ArtifactKind;
  label: string;
  description: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
}

export interface LocalExportResult {
  id: string;
  presetLabel: string;
  createdAt: string;
  durationSeconds: number;
  artifacts: LocalExportArtifact[];
  warnings: string[];
}

interface ZipEntry {
  name: string;
  blob: Blob;
}

interface CanvasSize {
  width: number;
  height: number;
}

const textEncoder = new TextEncoder();

export async function generateLocalExport(
  file: File,
  previewUrl: string,
  draft: ConversionDraft,
  metadata: VideoMetadata,
): Promise<LocalExportResult> {
  if (draft.mode === 'cloud') {
    throw new Error('cloud-processing-not-enabled');
  }

  if (file.size > productLimits.localFileSizeBytes) {
    throw new Error('cloud-required');
  }

  const preset = exportPresets[draft.presetId];
  const exportId = createExportId();
  const createdAt = new Date().toISOString();
  const baseName = `${sanitizeFileName(removeExtension(file.name))}-${draft.presetId}-${exportId.slice(0, 8)}`;
  const durationSeconds = Math.max(productLimits.minDurationSeconds, draft.endSeconds - draft.startSeconds);
  const warnings: string[] = [];
  const artifacts: LocalExportArtifact[] = [];

  let coverBlob: Blob | null = null;

  if (!isGifFile(file)) {
    const coverFrame = await captureCoverFrame(previewUrl, draft.keyframeSeconds);

    if (coverFrame) {
      coverBlob = dataUrlToBlob(coverFrame);
      artifacts.push({
        id: 'cover',
        kind: 'cover',
        label: '关键帧 JPEG',
        description: '用于 Live Photo 静态封面和导出结果预览。',
        fileName: `${baseName}-cover.jpg`,
        mimeType: coverBlob.type,
        blob: coverBlob,
      });
    } else {
      warnings.push('未能抓取关键帧，导出包会缺少静态封面。');
    }
  }

  if (isGifFile(file)) {
    warnings.push('GIF 的浏览器本地裁剪能力有限，当前导出包会保留原 GIF 作为兜底素材。');
    artifacts.push({
      id: 'source-gif',
      kind: 'source',
      label: '原始 GIF',
      description: '当前 Phase 1 对 GIF 使用原文件兜底，后续可接入 GIF 转码。',
      fileName: `${baseName}.gif`,
      mimeType: file.type || 'image/gif',
      blob: file,
    });
  } else {
    if (!draft.muted) {
      warnings.push('浏览器本地录制暂不保留原始音频；需要音频时请在 Beta 云端处理。');
    }

    const clipBlob = await recordVideoClip(previewUrl, draft, metadata);
    const clipExtension = getVideoExtension(clipBlob.type);

    artifacts.push({
      id: 'clip',
      kind: 'clip',
      label: `${clipExtension.toUpperCase()} 动态片段`,
      description: '按时间轴和画面比例生成的本地动态片段。',
      fileName: `${baseName}-clip.${clipExtension}`,
      mimeType: clipBlob.type || `video/${clipExtension}`,
      blob: clipBlob,
    });
  }

  const manifestBlob = createJsonBlob({
    exportId,
    createdAt,
    source: {
      name: file.name,
      sizeBytes: file.size,
      mimeType: file.type || 'unknown',
      metadata,
    },
    draft,
    preset,
    warnings,
    note: 'Phase 1 本地 MVP 导出包。Apple Live Photo 完整元数据和真机保存路径仍需按兼容矩阵验证。',
  });
  const readmeBlob = createTextBlob(createReadmeText(draft, warnings));

  const supportArtifacts: LocalExportArtifact[] = [
    {
      id: 'manifest',
      kind: 'manifest',
      label: '导出 Manifest',
      description: '记录预设、时间轴、关键帧和兼容提示，方便后续真机复测。',
      fileName: `${baseName}-manifest.json`,
      mimeType: 'application/json',
      blob: manifestBlob,
    },
    {
      id: 'readme',
      kind: 'manifest',
      label: '保存指引',
      description: '包含 iPhone Safari、AirDrop、Shortcuts 和锁屏排查说明。',
      fileName: `${baseName}-README.txt`,
      mimeType: 'text/plain',
      blob: readmeBlob,
    },
  ];

  const packageEntries: ZipEntry[] = [...artifacts, ...supportArtifacts].map((artifact) => ({
    name: artifact.fileName,
    blob: artifact.blob,
  }));
  const packageBlob = await createZipArchive(packageEntries);

  return {
    id: exportId,
    presetLabel: preset.label,
    createdAt,
    durationSeconds,
    warnings,
    artifacts: [
      {
        id: 'package',
        kind: 'package',
        label: '导出 ZIP 包',
        description: '包含封面、动态片段、manifest 和保存指引。',
        fileName: `${baseName}.zip`,
        mimeType: 'application/zip',
        blob: packageBlob,
      },
      ...artifacts,
      ...supportArtifacts,
    ],
  };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function isGifFile(file: File): boolean {
  return file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
}

function createExportId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function removeExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || 'vidlive';
}

function getVideoExtension(mimeType: string): 'mp4' | 'webm' {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [metadata = '', payload = ''] = dataUrl.split(',');
  const mimeType = metadata.match(/^data:(.*?);base64$/)?.[1] ?? 'image/jpeg';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function createJsonBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
}

function createTextBlob(value: string): Blob {
  return new Blob([value], { type: 'text/plain;charset=utf-8' });
}

function createReadmeText(draft: ConversionDraft, warnings: string[]): string {
  const preset = exportPresets[draft.presetId];
  const warningText = warnings.length > 0 ? warnings.map((warning) => `- ${warning}`).join('\n') : '- 暂无。';

  return [
    'VidLive Phase 1 本地导出包',
    '',
    `预设：${preset.label}`,
    `片段：${draft.startSeconds.toFixed(2)}s - ${draft.endSeconds.toFixed(2)}s`,
    `关键帧：${draft.keyframeSeconds.toFixed(2)}s`,
    `比例：${draft.aspectRatioId}`,
    `画面：${draft.fitMode === 'cover' ? '裁切填满' : '保留完整画面并补背景'}`,
    '',
    '保存路径建议：',
    '1. iPhone Safari：下载导出包后，按页面指引通过相册、文件 App 或 Shortcuts 保存。',
    '2. 桌面浏览器：下载 ZIP 后，通过 AirDrop 或数据线发送到 iPhone。',
    '3. 锁屏壁纸：优先使用 1-2 秒竖屏片段，确认 iOS 17+ 和 Live 开关。',
    '',
    '注意：',
    warningText,
    '',
    '当前为 Phase 1 MVP。本地包用于跑通导入、裁剪、关键帧和导出闭环；Apple Live Photo 完整元数据仍需真机验证。',
  ].join('\n');
}

async function recordVideoClip(videoUrl: string, draft: ConversionDraft, metadata: VideoMetadata): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('local-transcode-failed');
  }

  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context || typeof canvas.captureStream !== 'function') {
    throw new Error('local-transcode-failed');
  }

  const preset = exportPresets[draft.presetId];
  const fps = Math.min(preset.preferredFps ?? 30, 60);
  const size = resolveCanvasSize(draft.aspectRatioId, metadata);
  canvas.width = size.width;
  canvas.height = size.height;

  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  await waitForEvent(video, 'loadedmetadata');

  const sourceDuration = Number.isFinite(video.duration) ? video.duration : (metadata.durationSeconds ?? draft.endSeconds);
  const startSeconds = clampNumber(draft.startSeconds, 0, Math.max(0, sourceDuration - productLimits.minDurationSeconds));
  const endSeconds = clampNumber(draft.endSeconds, startSeconds + productLimits.minDurationSeconds, sourceDuration);

  video.currentTime = startSeconds;
  await waitForEvent(video, 'seeked');
  drawVideoFrame(context, video, canvas, draft.fitMode);

  const stream = canvas.captureStream(fps);
  const mimeType = selectRecorderMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  let animationFrameId = 0;

  const recordingStopped = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = () => reject(new Error('local-transcode-failed'));
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || 'video/webm';
      resolve(new Blob(chunks, { type }));
    };
  });

  const drawUntilEnd = new Promise<void>((resolve, reject) => {
    const startedAt = performance.now();
    const maxRuntimeMs = Math.max(2_000, (endSeconds - startSeconds + 1) * 1_500);

    const tick = () => {
      drawVideoFrame(context, video, canvas, draft.fitMode);

      if (video.currentTime >= endSeconds || video.ended) {
        resolve();
        return;
      }

      if (performance.now() - startedAt > maxRuntimeMs) {
        reject(new Error('local-transcode-failed'));
        return;
      }

      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);
  });

  try {
    recorder.start(250);
    await video.play();
    await drawUntilEnd;
  } catch (error) {
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }

    throw error instanceof Error ? error : new Error('local-transcode-failed');
  } finally {
    cancelAnimationFrame(animationFrameId);
    video.pause();
    video.removeAttribute('src');
    video.load();
    stream.getTracks().forEach((track) => track.stop());
  }

  if (recorder.state !== 'inactive') {
    recorder.stop();
  }

  const blob = await recordingStopped;

  if (blob.size === 0) {
    throw new Error('local-transcode-failed');
  }

  return blob;
}

function waitForEvent<T extends EventTarget>(target: T, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, handleSuccess);
      target.removeEventListener('error', handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('local-transcode-failed'));
    };

    target.addEventListener(eventName, handleSuccess, { once: true });
    target.addEventListener('error', handleError, { once: true });
  });
}

function selectRecorderMimeType(): string {
  const candidates = [
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

function resolveCanvasSize(aspectRatioId: AspectRatioId, metadata: VideoMetadata): CanvasSize {
  const sourceWidth = metadata.width ?? 720;
  const sourceHeight = metadata.height ?? 1280;
  const ratio = aspectRatios.find((item) => item.id === aspectRatioId)?.value ?? null;

  if (ratio === null) {
    return capSize(sourceWidth, sourceHeight);
  }

  if (ratio < 1) {
    return {
      width: roundEven(720),
      height: roundEven(720 / ratio),
    };
  }

  return {
    width: roundEven(Math.min(1280, 720 * ratio)),
    height: roundEven(720),
  };
}

function capSize(width: number, height: number): CanvasSize {
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(width, height));

  return {
    width: roundEven(width * scale),
    height: roundEven(height * scale),
  };
}

function roundEven(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function drawVideoFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  fitMode: FitMode,
): void {
  const sourceWidth = video.videoWidth || canvas.width;
  const sourceHeight = video.videoHeight || canvas.height;
  const scale =
    fitMode === 'cover'
      ? Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight)
      : Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (canvas.width - drawWidth) / 2;
  const drawY = (canvas.height - drawHeight) / 2;

  context.fillStyle = '#111827';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(video, drawX, drawY, drawWidth, drawHeight);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function createZipArchive(entries: ZipEntry[]): Promise<Blob> {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const name = textEncoder.encode(entry.name);
    const crc = crc32(data);
    const date = new Date();
    const { dosTime, dosDate } = toDosDateTime(date);
    const localHeader = createLocalFileHeader(name.length, crc, data.length, dosTime, dosDate);
    const centralHeader = createCentralDirectoryHeader(name.length, crc, data.length, dosTime, dosDate, offset);

    localParts.push(localHeader, name, data);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = sumByteLength(centralParts);
  const endRecord = createEndOfCentralDirectory(entries.length, centralSize, centralOffset);

  return new Blob([...localParts, ...centralParts, endRecord].map(toArrayBuffer), { type: 'application/zip' });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function createLocalFileHeader(
  fileNameLength: number,
  crc: number,
  size: number,
  dosTime: number,
  dosDate: number,
): Uint8Array {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, fileNameLength, true);
  view.setUint16(28, 0, true);

  return bytes;
}

function createCentralDirectoryHeader(
  fileNameLength: number,
  crc: number,
  size: number,
  dosTime: number,
  dosDate: number,
  localHeaderOffset: number,
): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, fileNameLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localHeaderOffset, true);

  return bytes;
}

function createEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);

  return bytes;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosTime, dosDate };
}

function sumByteLength(parts: Uint8Array[]): number {
  return parts.reduce((total, part) => total + part.length, 0);
}

const crcTable = createCrcTable();

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  }

  return (crc ^ 0xffffffff) >>> 0;
}
