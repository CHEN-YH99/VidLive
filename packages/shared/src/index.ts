export const productLimits = {
  localFileSizeBytes: 100 * 1024 * 1024,
  cloudFileSizeBytes: 500 * 1024 * 1024,
  minDurationSeconds: 1,
  recommendedMaxDurationSeconds: 30,
  localTargetDurationSeconds: 10,
} as const;

export const supportedInputs = [
  {
    extension: 'mp4',
    mimeTypes: ['video/mp4'],
    label: 'MP4',
  },
  {
    extension: 'mov',
    mimeTypes: ['video/quicktime', 'video/mov'],
    label: 'MOV',
  },
  {
    extension: 'gif',
    mimeTypes: ['image/gif'],
    label: 'GIF',
  },
] as const;

export type ProcessingMode = 'local' | 'cloud';

export type ExportPresetId = 'standard-live-photo' | 'ios-lock-screen' | 'social-fallback';

export type AspectRatioId = 'source' | '9:16' | '1:1' | '4:5' | '16:9';

export type FitMode = 'cover' | 'contain';

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  target: string;
  defaultDurationSeconds: number;
  preferredAspectRatio: AspectRatioId;
  preferredFps?: number;
  outputs: Array<'zip' | 'mov' | 'jpeg' | 'mp4' | 'gif'>;
}

export const exportPresets: Record<ExportPresetId, ExportPreset> = {
  'standard-live-photo': {
    id: 'standard-live-photo',
    label: '标准 Live Photo',
    target: '相册保存和后续导入',
    defaultDurationSeconds: 3,
    preferredAspectRatio: 'source',
    outputs: ['zip', 'mov', 'jpeg', 'mp4'],
  },
  'ios-lock-screen': {
    id: 'ios-lock-screen',
    label: 'iOS 锁屏壁纸',
    target: 'iOS 17+ 锁屏播放优先',
    defaultDurationSeconds: 2,
    preferredAspectRatio: '9:16',
    preferredFps: 60,
    outputs: ['zip', 'mov', 'jpeg', 'mp4'],
  },
  'social-fallback': {
    id: 'social-fallback',
    label: '社交兜底',
    target: '聊天和社交平台分享',
    defaultDurationSeconds: 3,
    preferredAspectRatio: 'source',
    outputs: ['mp4', 'gif'],
  },
};

export const aspectRatios: Array<{
  id: AspectRatioId;
  label: string;
  value: number | null;
}> = [
  { id: 'source', label: '原始', value: null },
  { id: '9:16', label: '9:16', value: 9 / 16 },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '4:5', label: '4:5', value: 4 / 5 },
  { id: '16:9', label: '16:9', value: 16 / 9 },
];

export type FailureReason =
  | 'file-too-large'
  | 'unsupported-format'
  | 'metadata-read-failed'
  | 'browser-memory-low'
  | 'local-transcode-failed'
  | 'cloud-required'
  | 'cloud-timeout'
  | 'expired-link'
  | 'lock-screen-not-playing';

export interface FailureAdvice {
  reason: FailureReason;
  title: string;
  action: string;
}

export const failureAdvice: Record<FailureReason, FailureAdvice> = {
  'file-too-large': {
    reason: 'file-too-large',
    title: '文件过大',
    action: '缩短素材、压缩文件，或切换云端处理。',
  },
  'unsupported-format': {
    reason: 'unsupported-format',
    title: '格式不支持',
    action: '请使用 MP4、MOV 或 GIF，HEVC 可尝试云端处理。',
  },
  'metadata-read-failed': {
    reason: 'metadata-read-failed',
    title: '素材解析失败',
    action: '换一个 H.264 MP4 文件，或重新导出原视频。',
  },
  'browser-memory-low': {
    reason: 'browser-memory-low',
    title: '浏览器内存不足',
    action: '缩短到 1-2 秒，关闭其他页面，或切换云端处理。',
  },
  'local-transcode-failed': {
    reason: 'local-transcode-failed',
    title: '本地转换失败',
    action: '降低分辨率、改用 MP4 兜底，或切换云端处理。',
  },
  'cloud-required': {
    reason: 'cloud-required',
    title: '需要云端处理',
    action: '确认上传和删除规则后再继续。',
  },
  'cloud-timeout': {
    reason: 'cloud-timeout',
    title: '云端任务超时',
    action: '缩短素材或稍后重试。',
  },
  'expired-link': {
    reason: 'expired-link',
    title: '下载链接已过期',
    action: '重新生成文件。',
  },
  'lock-screen-not-playing': {
    reason: 'lock-screen-not-playing',
    title: '锁屏未播放',
    action: '使用 1-2 秒竖屏片段，确认 iOS 版本和 Live 开关。',
  },
};

export interface VideoMetadata {
  name: string;
  sizeBytes: number;
  mimeType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
}

export interface ConversionDraft {
  mode: ProcessingMode;
  presetId: ExportPresetId;
  aspectRatioId: AspectRatioId;
  fitMode: FitMode;
  startSeconds: number;
  endSeconds: number;
  keyframeSeconds: number;
  muted: boolean;
}
