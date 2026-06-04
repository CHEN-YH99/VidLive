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

export type RotationDegrees = 0 | 90 | 180 | 270;

export interface ExportPreset {
  id: ExportPresetId;
  label: string;
  target: string;
  defaultDurationSeconds: number;
  preferredAspectRatio: AspectRatioId;
  preferredFps?: number;
  outputs: Array<'zip' | 'mov' | 'jpeg' | 'mp4' | 'gif' | 'webp'>;
}

export const exportPresets: Record<ExportPresetId, ExportPreset> = {
  'standard-live-photo': {
    id: 'standard-live-photo',
    label: '标准 Live Photo',
    target: '相册保存和后续导入',
    defaultDurationSeconds: 3,
    preferredAspectRatio: 'source',
    outputs: ['zip', 'mov', 'jpeg', 'mp4', 'webp'],
  },
  'ios-lock-screen': {
    id: 'ios-lock-screen',
    label: 'iOS 锁屏壁纸',
    target: 'iOS 17+ 锁屏播放优先',
    defaultDurationSeconds: 2,
    preferredAspectRatio: '9:16',
    preferredFps: 60,
    outputs: ['zip', 'mov', 'jpeg', 'mp4', 'webp'],
  },
  'social-fallback': {
    id: 'social-fallback',
    label: '社交兜底',
    target: '聊天和社交平台分享',
    defaultDurationSeconds: 3,
    preferredAspectRatio: 'source',
    outputs: ['mp4', 'gif', 'webp'],
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
  backgroundColor: string;
  rotationDegrees: RotationDegrees;
  flipHorizontal: boolean;
  flipVertical: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  startSeconds: number;
  endSeconds: number;
  keyframeSeconds: number;
  muted: boolean;
}

export type ValidationStatus = 'pass' | 'warn' | 'pending';

export interface ValidationModule {
  id: string;
  title: string;
  summary: string;
  status: ValidationStatus;
  proof: string;
}

export interface SavePathStep {
  id: string;
  label: string;
  status: ValidationStatus;
  hint: string;
  steps: string[];
}

export interface CompatibilityRow {
  id: string;
  environment: string;
  priority: string;
  importReady: ValidationStatus;
  trimReady: ValidationStatus;
  exportReady: ValidationStatus;
  saveReady: ValidationStatus;
  lockScreenReady: ValidationStatus;
  note: string;
}

export interface ExitCriterion {
  id: string;
  title: string;
  detail: string;
}

export const phaseZeroModules: ValidationModule[] = [
  {
    id: 'live-photo-poc',
    title: 'Live Photo 生成 POC',
    summary: '确认短视频能走完导入、裁剪、封面帧和导出组合。',
    status: 'warn',
    proof: '需要真机导入样例和导出包验证。',
  },
  {
    id: 'save-path-matrix',
    title: '保存路径矩阵',
    summary: '验证 iPhone Safari、AirDrop、Shortcuts、桌面 ZIP 路径。',
    status: 'pass',
    proof: '已有路径说明，仍需真机复测。',
  },
  {
    id: 'lockscreen-check',
    title: '锁屏兼容检查',
    summary: '对 1-2 秒竖屏片段、60 FPS 源素材和播放行为做矩阵记录。',
    status: 'pending',
    proof: '等待多机型和多 iOS 版本实测。',
  },
  {
    id: 'local-first-check',
    title: '本地优先验证',
    summary: '确认 100MB 内素材不会上传服务器，失败再切换云端。',
    status: 'pass',
    proof: '前端已默认本地模式，云端为显式选择。',
  },
];

export const savePathSteps: SavePathStep[] = [
  {
    id: 'iphone-safari',
    label: 'iPhone Safari',
    status: 'warn',
    hint: '最接近真实用户路径。',
    steps: ['导入素材', '下载导出包', '保存到相册', '检查锁屏设置'],
  },
  {
    id: 'airdrop',
    label: 'AirDrop',
    status: 'pass',
    hint: '手机和桌面之间的低摩擦迁移方式。',
    steps: ['桌面生成 ZIP', '发送到 iPhone', '相册保存', '锁屏测试'],
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    status: 'pending',
    hint: '用于绕过浏览器写入限制的备用方案。',
    steps: ['确认快捷指令', '导入文件', '写入相册', '再次播放验证'],
  },
  {
    id: 'desktop-zip',
    label: '桌面 ZIP 下载',
    status: 'pass',
    hint: '适合先在桌面完成完整导出。',
    steps: ['生成 ZIP', '下载到本地', '传到手机', '复查封面帧'],
  },
];

export const compatibilityRows: CompatibilityRow[] = [
  {
    id: 'iphone-safari',
    environment: 'iPhone Safari',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'warn',
    saveReady: 'warn',
    lockScreenReady: 'pending',
    note: '重点看保存路径和锁屏播放。',
  },
  {
    id: 'macos-safari',
    environment: 'macOS Safari',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'pass',
    saveReady: 'pass',
    lockScreenReady: 'pending',
    note: '适合先做完整导出包验证。',
  },
  {
    id: 'chrome-desktop',
    environment: 'Chrome Desktop',
    priority: 'P1',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'warn',
    saveReady: 'pass',
    lockScreenReady: 'pending',
    note: '重点观察本地转码与下载行为。',
  },
  {
    id: 'edge-desktop',
    environment: 'Edge Desktop',
    priority: 'P1',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'warn',
    saveReady: 'pass',
    lockScreenReady: 'pending',
    note: '重点检查兼容性和下载提示。',
  },
  {
    id: 'ios17-device',
    environment: 'iOS 17+ 真机',
    priority: 'P0',
    importReady: 'pending',
    trimReady: 'pending',
    exportReady: 'pending',
    saveReady: 'pending',
    lockScreenReady: 'pending',
    note: '重点验证标准 Live Photo 识别和锁屏播放。',
  },
];

export const phaseZeroExitCriteria: ExitCriterion[] = [
  {
    id: 'one-path',
    title: '至少一条保存路径可用',
    detail: '确认从浏览器到 iPhone 相册的完整链路。',
  },
  {
    id: 'lockscreen-evidence',
    title: '锁屏播放有真机记录',
    detail: '记录成功/失败条件，不把结果写成猜测。',
  },
  {
    id: 'local-first-proof',
    title: '本地模式不上传素材',
    detail: '抓包或日志确认不发送原始视频和缩略图。',
  },
  {
    id: 'fallback-rule',
    title: '云端兜底触发规则明确',
    detail: '文件过大、编码不支持或本地失败时切换。',
  },
];
