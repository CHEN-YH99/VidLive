import {
  aspectRatios,
  exportPresets,
  productLimits,
  type AspectRatioId,
  type ConversionDraft,
  type VideoMetadata,
} from '@vidlive/shared';
import { captureCoverFrame } from '@/lib/file-inspector';

export type ArtifactKind = 'package' | 'cover' | 'clip' | 'webp' | 'manifest' | 'source';

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
  const timestamp = new Date()
    .toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '')
    .replace(/:/g, '')
    .replace(/\s/g, '-');
  const baseName = `VidLive-${sanitizeFileName(removeExtension(file.name))}-${draft.presetId}-${timestamp}`;
  const durationSeconds = Math.max(productLimits.minDurationSeconds, draft.endSeconds - draft.startSeconds);
  const warnings: string[] = [
    '当前本地导出的是 ZIP 素材包，不是 Android Motion Photo 单文件。',
    '安卓实况图以云端生成的 motion-photo_MP.jpg 为准，优先用 Google Photos 或主流视频平台复测。',
  ];
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
        description: '用于安卓实况图封面验证和导出结果预览。',
        fileName: `${baseName}-cover.jpg`,
        mimeType: coverBlob.type,
        blob: coverBlob,
      });
      const webpBlob = await createWebpFrameBlob(coverFrame);

      if (webpBlob) {
        artifacts.push({
          id: 'webp-preview',
          kind: 'webp',
          label: 'WebP 预览',
          description: '用于网页预览和通用格式兼容检查。',
          fileName: `${baseName}-preview.webp`,
          mimeType: webpBlob.type,
          blob: webpBlob,
        });
      } else {
        warnings.push('当前浏览器未能生成 WebP 预览，可切换云端处理。');
      }
    } else {
      warnings.push('未能抓取关键帧，导出包会缺少静态封面。');
    }
  }

  if (isGifFile(file)) {
    warnings.push('GIF 的浏览器本地裁剪能力有限，当前导出包会保留原 GIF 作为备用素材。');
    artifacts.push({
      id: 'source-gif',
      kind: 'source',
      label: '原始 GIF',
      description: '保留原始 GIF，便于云端处理或兼容复测。',
      fileName: `${baseName}.gif`,
      mimeType: file.type || 'image/gif',
      blob: file,
    });
  } else {
    if (!draft.muted) {
      warnings.push('浏览器本地录制暂不保留原始音频；需要音频时请使用云端处理。');
    }

    try {
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
    } catch {
      const sourceExtension = getSourceExtension(file);

      warnings.push('浏览器本地录制动态片段失败，导出包已保留原始视频作为备用素材；请缩短片段、降低分辨率，或切换云端处理。');
      artifacts.push({
        id: 'source-video',
        kind: 'source',
        label: '原始视频备份',
        description: '本地裁剪录制失败时保留的原始素材，方便继续用云端处理复测。',
        fileName: `${baseName}-source${sourceExtension}`,
        mimeType: file.type || (sourceExtension === '.mov' ? 'video/quicktime' : 'video/mp4'),
        blob: file,
      });
    }
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
    livePhotoRecognition: 'not-ready-local-web-export',
    metadataInjected: false,
    warnings,
    note: 'VidLive 本地导出包用于预览、裁剪、关键帧和兼容格式导出；Android Motion Photo 单文件以云端 motion-photo_MP.jpg 为准。',
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
      description: '包含 Android Motion Photo、Google Photos、主流视频平台和厂商系统相册兼容性排查说明。',
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
        label: '素材 ZIP 包',
        description: '包含封面、动态片段、manifest 和保存指引；安卓实况单文件请使用云端生成结果。',
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

function getSourceExtension(file: File): '.mp4' | '.mov' {
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];

  if (extension === '.mov') {
    return '.mov';
  }

  return '.mp4';
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

async function createWebpFrameBlob(dataUrl: string): Promise<Blob | null> {
  const image = new Image();
  image.decoding = 'async';
  image.src = dataUrl;

  await waitForEvent(image, 'load');

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    return null;
  }

  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  context.drawImage(image, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob && blob.type === 'image/webp' ? blob : null);
      },
      'image/webp',
      0.86,
    );
  });
}

function createReadmeText(draft: ConversionDraft, warnings: string[]): string {
  const preset = exportPresets[draft.presetId];
  const warningText = warnings.length > 0 ? warnings.map((warning) => `- ${warning}`).join('\n') : '- 暂无。';

  return [
    'VidLive 本地导出包',
    '',
    '重要说明：当前 ZIP 是本地素材包，用于预览、裁剪、关键帧和兼容格式导出；它不是 Android Motion Photo 单文件。若要验证安卓实况图，请使用云端生成的 motion-photo_MP.jpg。',
    '',
    `预设：${preset.label}`,
    `片段：${draft.startSeconds.toFixed(2)}s - ${draft.endSeconds.toFixed(2)}s`,
    `关键帧：${draft.keyframeSeconds.toFixed(2)}s`,
    `比例：${draft.aspectRatioId}`,
    `画面：${draft.fitMode === 'cover' ? '裁切填满' : '保留完整画面并补背景'}`,
    '',
    '保存路径建议：',
    '1. 安卓浏览器：云端生成后直接下载 motion-photo_MP.jpg。',
    '2. Google Photos / 主流视频平台：优先用它们验证动态图入口。',
    '3. ColorOS / 鸿蒙系统相册：若只显示静态图，按查看器兼容性限制记录。',
    '4. 桌面浏览器：下载 ZIP 后，取出素材做通用格式交付或兼容复测。',
    '',
    '注意：',
    warningText,
    '',
    '本地包用于完成导入、裁剪、关键帧和通用格式导出；安卓实况主产物由云端链路生成。',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '【免责声明】',
    '',
    '1. 本工具仅供学习、研究和技术交流使用，不得用于任何商业用途。',
    '',
    '2. 使用本工具生成的素材，请确保您拥有原始视频的合法使用权。',
    '',
    '3. 严禁使用本工具处理、传播任何违反法律法规的内容，包括但不限于：',
    '   - 侵犯他人知识产权的内容',
    '   - 涉及色情、暴力、恐怖主义的内容',
    '   - 侵犯他人隐私或肖像权的内容',
    '   - 其他违反当地法律法规的内容',
    '',
    '4. 用户在使用本工具时应遵守所在国家和地区的法律法规，因使用本工具',
    '   产生的任何法律责任由用户自行承担，本工具开发者不承担任何责任。',
    '',
    '5. 本工具按"现状"提供，不提供任何形式的明示或暗示保证，包括但不限于',
    '   适销性、特定用途适用性和非侵权性的保证。',
    '',
    '6. 本工具开发者保留随时修改、暂停或终止服务的权利，无需事先通知。',
    '',
    '使用本工具即表示您已阅读、理解并同意遵守以上免责声明。',
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
  drawVideoFrame(context, video, canvas, draft);

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
      drawVideoFrame(context, video, canvas, draft);

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
  draft: ConversionDraft,
): void {
  const sourceWidth = video.videoWidth || canvas.width;
  const sourceHeight = video.videoHeight || canvas.height;
  const rotation = normalizeRotation(draft.rotationDegrees);
  const rotated = rotation === 90 || rotation === 270;
  const targetWidth = rotated ? canvas.height : canvas.width;
  const targetHeight = rotated ? canvas.width : canvas.height;
  const scale =
    draft.fitMode === 'cover'
      ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
      : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;

  context.fillStyle = normalizeBackgroundColor(draft.backgroundColor);
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.scale(draft.flipHorizontal ? -1 : 1, draft.flipVertical ? -1 : 1);
  context.filter = createCanvasFilter(draft);
  context.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
  context.filter = 'none';
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;

  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

function createCanvasFilter(draft: ConversionDraft): string {
  return [
    `brightness(${clampNumber(draft.brightness, 50, 150)}%)`,
    `contrast(${clampNumber(draft.contrast, 50, 150)}%)`,
    `saturate(${clampNumber(draft.saturation, 0, 200)}%)`,
  ].join(' ');
}

function normalizeBackgroundColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#111827';
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
