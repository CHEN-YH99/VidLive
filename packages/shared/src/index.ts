export const productLimits = {
  localFileSizeBytes: 100 * 1024 * 1024,
  cloudFileSizeBytes: 500 * 1024 * 1024,
  minDurationSeconds: 1,
  livePhotoMaxDurationSeconds: 3,
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
  maxDurationSeconds: number;
  preferredAspectRatio: AspectRatioId;
  preferredFps?: number;
  outputs: Array<'zip' | 'mov' | 'jpeg' | 'mp4' | 'gif' | 'webp'>;
}

export const exportPresets: Record<ExportPresetId, ExportPreset> = {
  'standard-live-photo': {
    id: 'standard-live-photo',
    label: '标准安卓实况图',
    target: '标准动态照片片段，最长 3 秒',
    defaultDurationSeconds: 3,
    maxDurationSeconds: productLimits.livePhotoMaxDurationSeconds,
    preferredAspectRatio: 'source',
    outputs: ['zip', 'mov', 'jpeg', 'mp4', 'webp'],
  },
  'ios-lock-screen': {
    id: 'ios-lock-screen',
    label: '安卓竖屏实况图',
    target: '默认 2 秒，9:16 竖屏，优先 Google Photos 和抖音识别',
    defaultDurationSeconds: 2,
    maxDurationSeconds: productLimits.livePhotoMaxDurationSeconds,
    preferredAspectRatio: '9:16',
    preferredFps: 60,
    outputs: ['zip', 'mov', 'jpeg', 'mp4', 'webp'],
  },
  'social-fallback': {
    id: 'social-fallback',
    label: '通用格式导出',
    target: '导出 MP4 / GIF / WebP 通用格式',
    defaultDurationSeconds: 3,
    maxDurationSeconds: productLimits.livePhotoMaxDurationSeconds,
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
    action: '降低分辨率、导出通用 MP4，或切换云端处理。',
  },
  'cloud-required': {
    reason: 'cloud-required',
    title: '需要云端处理',
    action: '确认上传和删除规则后再继续。',
  },
  'cloud-timeout': {
    reason: 'cloud-timeout',
    title: '云端处理失败',
    action: '确认后端服务已启动，缩短素材后重试。',
  },
  'expired-link': {
    reason: 'expired-link',
    title: '下载链接已过期',
    action: '重新生成导出结果。',
  },
  'lock-screen-not-playing': {
    reason: 'lock-screen-not-playing',
    title: '动态照片未播放',
    action: '使用 1-2 秒竖屏片段，优先用 Google Photos 或抖音复测；ColorOS / 鸿蒙系统相册可能不识别。',
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

export type CompatibilityOsName = 'Android' | 'HarmonyOS' | 'Other';

export type CompatibilityDownloadResult = 'success' | 'failed' | 'unknown';

export type CompatibilityTransferPath =
  | 'browser-direct'
  | 'usb'
  | 'wechat'
  | 'qq'
  | 'cloud-drive'
  | 'unknown';

export type CompatibilityViewerId =
  | 'system-gallery'
  | 'google-photos'
  | 'douyin'
  | 'file-manager'
  | 'wechat'
  | 'other';

export type CompatibilityViewerOutcome = 'recognized' | 'still' | 'failed' | 'not-tested';

export type CompatibilityConfidence = 'A' | 'B' | 'C' | 'D';

export interface CompatibilityViewerReport {
  viewer: CompatibilityViewerId;
  outcome: CompatibilityViewerOutcome;
  appVersion?: string;
  note?: string;
}

export interface CompatibilityReportInput {
  sampleId: string;
  sampleSha256?: string;
  deviceBrand?: string;
  deviceModel?: string;
  osName: CompatibilityOsName;
  osVersion?: string;
  browserName?: string;
  browserVersion?: string;
  downloadResult: CompatibilityDownloadResult;
  transferPath: CompatibilityTransferPath;
  viewers: CompatibilityViewerReport[];
  notes?: string;
}

export interface CompatibilityReport extends CompatibilityReportInput {
  id: string;
  createdAt: string;
  confidence: CompatibilityConfidence;
  userAgent: string;
}

export interface CompatibilityViewerSummary {
  viewer: CompatibilityViewerId;
  total: number;
  recognized: number;
  still: number;
  failed: number;
  notTested: number;
}

export interface CompatibilityEnvironmentSummary {
  key: string;
  osName: CompatibilityOsName;
  osVersion?: string;
  deviceBrand?: string;
  deviceModel?: string;
  total: number;
  recognized: number;
  hasSystemGalleryLimit: boolean;
}

export interface CompatibilitySummary {
  sampleId: string;
  reportCount: number;
  viewerStats: CompatibilityViewerSummary[];
  environmentStats: CompatibilityEnvironmentSummary[];
  latestReports: CompatibilityReport[];
}

export interface CompatibilityTestKit {
  sampleId: string;
  fileName: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  generatedAt: string;
}

export const compatibilitySampleId = 'android-motion-photo-v1';

export interface ExitCriterion {
  id: string;
  title: string;
  detail: string;
}

export const phaseZeroModules: ValidationModule[] = [
  {
    id: 'android-motion-photo-poc',
    title: 'Android Motion Photo 生成验证',
    summary: '确认短视频能走完导入、裁剪、封面帧、Motion Photo 单文件和 ZIP 导出。',
    status: 'pass',
    proof: '已用 Android 真机验证 motion-photo_MP.jpg 可被系统识别为实况图。',
  },
  {
    id: 'save-path-matrix',
    title: '保存路径矩阵',
    summary: '验证 Android 浏览器直下、桌面 ZIP、USB 原文件传输和相册扫描路径。',
    status: 'pass',
    proof: 'Android 局域网访问、云端任务、下载和真机识别链路已打通。',
  },
  {
    id: 'android-gallery-check',
    title: '安卓查看器识别检查',
    summary: '对 1-3 秒竖屏片段、60 FPS 源素材、有声素材和查看器播放行为做矩阵记录。',
    status: 'warn',
    proof: 'ColorOS / 鸿蒙系统相册暂不识别；Google Photos 和抖音已能识别动态图。',
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
    id: 'android-browser',
    label: 'Android 浏览器',
    status: 'pass',
    hint: '最接近真实用户路径。',
    steps: ['导入素材', '生成安卓实况图', '下载 motion-photo_MP.jpg', '用相册检查动态入口'],
  },
  {
    id: 'desktop-usb',
    label: '桌面 USB',
    status: 'pass',
    hint: '手机和桌面之间的低摩擦迁移方式。',
    steps: ['桌面生成 ZIP', '取出 motion-photo_MP.jpg', 'USB 原文件传输', '相册刷新验证'],
  },
  {
    id: 'google-photos',
    label: 'Google Photos',
    status: 'pass',
    hint: '用于判断标准 Motion Photo 结构是否被主流查看器识别。',
    steps: ['下载原文件', 'Google Photos 打开', '检查 Motion Photo 入口', '记录播放结果'],
  },
  {
    id: 'douyin',
    label: '抖音',
    status: 'pass',
    hint: '用于验证社交平台是否保留并识别动态照片结构。',
    steps: ['上传原文件', '检查动态图入口', '发布前预览', '记录播放结果'],
  },
  {
    id: 'desktop-zip',
    label: '桌面 ZIP 下载',
    status: 'pass',
    hint: '适合先在桌面完成完整导出。',
    steps: ['生成 ZIP', '下载到本地', '解压单文件', '传到手机复查'],
  },
];

export const compatibilityRows: CompatibilityRow[] = [
  {
    id: 'coloros-browser',
    environment: 'ColorOS Edge / 系统浏览器',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'pass',
    saveReady: 'pass',
    lockScreenReady: 'warn',
    note: '浏览器下载链路通过；ColorOS 系统相册暂不识别动态图。',
  },
  {
    id: 'harmonyos-browser',
    environment: '鸿蒙系统自带浏览器',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'pass',
    saveReady: 'pass',
    lockScreenReady: 'warn',
    note: '浏览器下载链路通过；鸿蒙系统相册暂不识别动态图，抖音可识别。',
  },
  {
    id: 'google-photos',
    environment: 'Google Photos',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'pass',
    saveReady: 'pass',
    lockScreenReady: 'pass',
    note: '已验证可识别 motion-photo_MP.jpg 的 Motion Photo 入口和播放行为。',
  },
  {
    id: 'douyin',
    environment: '抖音',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pass',
    exportReady: 'pass',
    saveReady: 'pass',
    lockScreenReady: 'pass',
    note: '已验证上传后可识别动态图，适合作为社交平台发布路径。',
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
    note: '重点观察本地预览、ZIP 下载和扫码传手机。',
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
    id: 'coloros-system-gallery',
    environment: 'ColorOS 系统相册',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pending',
    exportReady: 'pass',
    saveReady: 'warn',
    lockScreenReady: 'warn',
    note: '已确认当前 ColorOS 系统相册不识别该 Motion Photo；不作为主成功标准。',
  },
  {
    id: 'harmonyos-system-gallery',
    environment: '鸿蒙系统相册',
    priority: 'P0',
    importReady: 'pass',
    trimReady: 'pending',
    exportReady: 'pass',
    saveReady: 'warn',
    lockScreenReady: 'warn',
    note: '已确认当前鸿蒙系统相册不识别该 Motion Photo；抖音可识别，系统相册不作为主成功标准。',
  },
];

export const phaseZeroExitCriteria: ExitCriterion[] = [
  {
    id: 'one-path',
    title: '至少一条保存路径可用',
    detail: '确认从 Android 浏览器下载到 Google Photos 或抖音识别的完整链路。',
  },
  {
    id: 'android-gallery-evidence',
    title: '安卓查看器播放有真机记录',
    detail: '记录 Google Photos、抖音、ColorOS 系统相册和鸿蒙系统相册的成功/失败条件。',
  },
  {
    id: 'local-first-proof',
    title: '本地模式不上传素材',
    detail: '抓包或日志确认不发送原始视频和缩略图。',
  },
  {
    id: 'fallback-rule',
    title: '云端处理触发规则明确',
    detail: '文件过大、编码不支持或本地失败时切换。',
  },
];
