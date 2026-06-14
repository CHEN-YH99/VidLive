'use client';

import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  Clock3,
  CloudOff,
  Crown,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  Film,
  ImageIcon,
  Info,
  LogIn,
  LogOut,
  Loader2,
  Lock,
  MonitorDown,
  Palette,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Upload,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { type FileRejection, useDropzone } from 'react-dropzone';
import QRCode from 'qrcode';
import {
  aspectRatios,
  exportPresets,
  failureAdvice,
  productLimits,
  supportedInputs,
  type AspectRatioId,
  type CompatibilityDownloadResult,
  type CompatibilityOsName,
  type CompatibilityReportInput,
  type CompatibilityTestKit,
  type CompatibilityTransferPath,
  type CompatibilityViewerId,
  type CompatibilityViewerOutcome,
  type ConversionDraft,
  type ExportPreset,
  type ExportPresetId,
  type FailureReason,
  type FitMode,
  type VideoMetadata,
} from '@vidlive/shared';
import {
  captureCoverFrame,
  inspectImageLikeFile,
  inspectMp4ContainerFile,
  inspectVideoFile,
  isSupportedInput,
} from '@/lib/file-inspector';
import { clamp, formatBytes, formatSeconds } from '@/lib/format';
import { downloadBlob, generateLocalExport, type LocalExportArtifact, type LocalExportResult } from '@/lib/local-export';
import { LoadingOverlay } from '@/components/loading-spinner';

const initialPreset = exportPresets['ios-lock-screen'];

const initialDraft: ConversionDraft = {
  mode: 'local',
  presetId: initialPreset.id,
  aspectRatioId: initialPreset.preferredAspectRatio,
  fitMode: 'cover',
  backgroundColor: '#111827',
  rotationDegrees: 0,
  flipHorizontal: false,
  flipVertical: false,
  brightness: 100,
  contrast: 100,
  saturation: 100,
  startSeconds: 0,
  endSeconds: initialPreset.defaultDurationSeconds,
  clipDurationSeconds: initialPreset.defaultDurationSeconds,
  keyframeSeconds: initialPreset.defaultDurationSeconds / 2,
  muted: true,
};

const phaseSteps = [
  { label: '导入', icon: <Upload size={15} /> },
  { label: '裁剪', icon: <Scissors size={15} /> },
  { label: '选帧', icon: <ImageIcon size={15} /> },
  { label: '导出', icon: <Download size={15} /> },
];

function resolveApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL;
  }

  return '/api/proxy';
}

const apiBaseUrl = resolveApiBaseUrl();

const backgroundColorOptions = [
  { label: '深色', value: '#111827' },
  { label: '白色', value: '#ffffff' },
  { label: '暖色', value: '#fff4df' },
  { label: '浅蓝', value: '#e4f7ff' },
  { label: '浅绿', value: '#d9f99d' },
] as const;

const modeHelpText = {
  local: '只在浏览器内解析和打包，不上传素材；适合生成预览封面、动态片段和保存指引。安卓实况单文件以云端结果为准。',
  cloud:
    '把素材提交到后端处理，用 FFmpeg 生成 Android Motion Photo 单文件、预览图和完整素材包；适合最终导出和真机验证。',
} as const;

const presetHelpText: Record<ExportPresetId, string> = {
  'standard-live-photo': '默认 3 秒，优先保留原素材比例，适合 Google Photos 或主流视频平台的标准动态照片验证。',
  'ios-lock-screen': '默认 2 秒，优先 9:16 竖屏，适合 Google Photos 和主流视频平台识别；ColorOS / 鸿蒙系统相册可能不识别。',
  'social-fallback': '输出 MP4 / GIF / WebP 等通用格式；适合动态照片结构无法保留时的兼容导出。',
};

type CloudJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'expired' | 'deleted';
type GenerationStatus = 'generating' | 'complete' | 'failed';
type AuthMode = 'login' | 'register' | 'reset-password';
type AuthLoginStep = 'email' | 'password';

interface CloudJob {
  id: string;
  status: CloudJobStatus;
  progress: number;
  expiresAt: string;
  artifact: {
    fileName: string;
    sizeBytes: number;
    downloadUrl: string;
    deleteUrl: string;
  } | null;
  androidMotionPhoto: {
    fileName: string;
    sizeBytes: number;
    downloadUrl: string;
  } | null;
  previewPhoto: {
    fileName: string;
    sizeBytes: number;
    downloadUrl: string;
  } | null;
  pairedVideo: {
    fileName: string;
    sizeBytes: number;
    downloadUrl: string;
  } | null;
  warnings: string[];
  error: {
    code: string;
    message: string;
  } | null;
}

interface KeyframeSuggestion {
  seconds: number;
  score: number;
  reasons: string[];
}

type CompatibilityViewerState = Record<CompatibilityViewerId, CompatibilityViewerOutcome>;

interface CompatibilityFormState {
  deviceBrand: string;
  deviceModel: string;
  osName: CompatibilityOsName;
  osVersion: string;
  browserName: string;
  browserVersion: string;
  downloadResult: CompatibilityDownloadResult;
  transferPath: CompatibilityTransferPath;
  viewers: CompatibilityViewerState;
  notes: string;
}

interface CompatibilityValidatedFormText {
  deviceBrand: string;
  deviceModel: string;
  osVersion: string;
  browserName: string;
  browserVersion: string;
  notes: string;
}

interface CompatibilityDownloadContext {
  fileName: string;
  downloadedAt: string;
  source: 'android-motion-photo' | 'cloud-package' | 'local-export' | 'test-kit' | 'manual';
}

interface CloudDownloadRequest {
  url: string;
  fileName: string;
  source: 'android-motion-photo' | 'cloud-package';
}

interface AuthUser {
  id: string;
  email: string;
  username: string;
  planType: 'free' | 'pro';
  dailyQuota: number;
  localQuotaDaily: number;
  cloudQuotaDaily: number;
  createdAt: string;
}

interface AuthSession {
  user: AuthUser;
  token?: string;
}

interface AuthUsageSummary {
  quotaLimit: number;
  usedToday: number;
  remainingToday: number;
  localLimit: number;
  localUsed: number;
  localRemaining: number;
  cloudLimit: number;
  cloudUsed: number;
  cloudRemaining: number;
}

type GenerationResource = 'free-local' | 'pro-local' | 'pro-cloud';
type GenerationAccessKind = 'auth-required' | 'ready' | 'pro-required' | 'quota-exhausted' | 'error';

interface GenerationAccessState {
  kind: GenerationAccessKind;
  usage: AuthUsageSummary | null;
  resource: GenerationResource | null;
  message?: string;
}

const compatibilityViewerOptions: Array<{ id: CompatibilityViewerId; label: string }> = [
  { id: 'system-gallery', label: '系统相册' },
  { id: 'google-photos', label: 'Google Photos' },
  { id: 'douyin', label: '主流视频平台' },
  { id: 'file-manager', label: '文件管理器' },
];

const compatibilityOutcomeOptions: Array<{ id: CompatibilityViewerOutcome; label: string }> = [
  { id: 'recognized', label: '识别' },
  { id: 'still', label: '静态' },
  { id: 'failed', label: '失败' },
  { id: 'not-tested', label: '未测' },
];

const compatibilityTextPattern = /^[\p{L}\p{N}\s._+()（）·/-]+$/u;
const compatibilityMeaningfulTextPattern = /[\p{L}\p{N}]/u;
const compatibilityControlCharacterClass = [
  `${String.fromCharCode(0)}-${String.fromCharCode(8)}`,
  String.fromCharCode(11),
  String.fromCharCode(12),
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}`,
  String.fromCharCode(127),
].join('');
const compatibilityControlCharacterPattern = new RegExp(`[${compatibilityControlCharacterClass}]`, 'u');
const compatibilityOsNameValues: CompatibilityOsName[] = ['Android', 'HarmonyOS', 'Other'];
const compatibilityDownloadResultValues: CompatibilityDownloadResult[] = ['success', 'failed', 'unknown'];
const compatibilityTransferPathValues: CompatibilityTransferPath[] = [
  'browser-direct',
  'usb',
  'wechat',
  'qq',
  'cloud-drive',
  'unknown',
];
const compatibilityViewerOutcomeValues = compatibilityOutcomeOptions.map((option) => option.id);

function isGif(file: File): boolean {
  return file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
}

function getDropError(rejections: FileRejection[]): FailureReason | null {
  const firstError = rejections[0]?.errors[0];

  if (!firstError) {
    return null;
  }

  if (firstError.code === 'file-too-large') {
    return 'file-too-large';
  }

  return 'unsupported-format';
}

function createCloudFallbackMetadata(file: File, presetId: ExportPresetId): VideoMetadata {
  const preset = exportPresets[presetId];

  return {
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type || 'video/unknown',
    durationSeconds: preset.maxDurationSeconds,
    width: null,
    height: null,
    hasAudio: null,
  };
}

function getDefaultDraftForPreset(
  presetId: ExportPresetId,
  previous: ConversionDraft,
  metadata: VideoMetadata | null,
): ConversionDraft {
  const preset = exportPresets[presetId];
  const clipDuration = getTargetClipDuration(preset, metadata?.durationSeconds);
  const endSeconds = clipDuration;
  const keyframeSeconds = endSeconds / 2;

  return {
    ...previous,
    presetId,
    aspectRatioId: preset.preferredAspectRatio,
    startSeconds: 0,
    endSeconds,
    clipDurationSeconds: clipDuration,
    keyframeSeconds,
  };
}

function getFailureFromExportError(error: unknown): FailureReason {
  if (!(error instanceof Error)) {
    return 'local-transcode-failed';
  }

  if (error.message === 'cloud-processing-not-enabled' || error.message === 'cloud-required') {
    return 'cloud-required';
  }

  return 'local-transcode-failed';
}

function isCloudJobActive(job: CloudJob | null): boolean {
  return job?.status === 'queued' || job?.status === 'processing';
}

function isEdgeBrowser(): boolean {
  if (typeof window === 'undefined' || !window.navigator) {
    return false;
  }
  const userAgent = window.navigator.userAgent.toLowerCase();
  return userAgent.includes('edg/') || userAgent.includes('edge/');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function startEstimatedLocalProgress(setProgress: Dispatch<SetStateAction<number>>): () => void {
  let stopped = false;
  let timerId = 0;
  const startedAt = performance.now();

  const tick = () => {
    if (stopped) {
      return;
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const estimate = Math.min(88, Math.round(18 + Math.log1p(elapsedSeconds * 1.8) * 28));
    setProgress((current) => Math.max(current, estimate));
    timerId = window.setTimeout(tick, 450);
  };

  timerId = window.setTimeout(tick, 250);

  return () => {
    stopped = true;
    window.clearTimeout(timerId);
  };
}

function createInitialCompatibilityForm(): CompatibilityFormState {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;

  return {
    deviceBrand: '',
    deviceModel: '',
    osName: detectOsName(userAgent),
    osVersion: '',
    browserName: detectBrowserName(userAgent),
    browserVersion: '',
    downloadResult: 'success',
    transferPath: 'browser-direct',
    viewers: {
      'system-gallery': 'not-tested',
      'google-photos': 'not-tested',
      douyin: 'not-tested',
      'file-manager': 'not-tested',
      wechat: 'not-tested',
      other: 'not-tested',
    },
    notes: '',
  };
}

function validateCompatibilityForm(form: CompatibilityFormState): {
  errors: string[];
  text: CompatibilityValidatedFormText;
} {
  const errors: string[] = [];
  const text: CompatibilityValidatedFormText = {
    deviceBrand: validateCompatibilityTextField('品牌', form.deviceBrand, 80, true, errors),
    deviceModel: validateCompatibilityTextField('机型', form.deviceModel, 100, true, errors),
    osVersion: validateCompatibilityTextField('系统版本', form.osVersion, 80, true, errors),
    browserName: validateCompatibilityTextField('浏览器', form.browserName, 80, true, errors),
    browserVersion: validateCompatibilityTextField('浏览器版本', form.browserVersion, 80, false, errors),
    notes: validateCompatibilityNotes(form.notes, errors),
  };
  const viewerOutcomes = compatibilityViewerOptions.map((option) => form.viewers[option.id] ?? 'not-tested');

  if (!compatibilityOsNameValues.includes(form.osName)) {
    errors.push('系统类型无效，请重新选择系统。');
  }

  if (!compatibilityDownloadResultValues.includes(form.downloadResult)) {
    errors.push('下载结果无效，请重新选择下载状态。');
  }

  if (!compatibilityTransferPathValues.includes(form.transferPath)) {
    errors.push('传输路径无效，请重新选择路径。');
  }

  if (viewerOutcomes.some((outcome) => !compatibilityViewerOutcomeValues.includes(outcome))) {
    errors.push('查看结果包含无效选项，请重新选择。');
  }

  if (!viewerOutcomes.some((outcome) => outcome !== 'not-tested')) {
    errors.push('请至少填写一个查看结果，不能全部保持“未测”。');
  }

  return { errors, text };
}

function validateCompatibilityTextField(
  label: string,
  value: string,
  maxLength: number,
  required: boolean,
  errors: string[],
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    if (required) {
      errors.push(`${label}不能为空。`);
    }

    return '';
  }

  if (trimmed.length > maxLength) {
    errors.push(`${label}不能超过 ${maxLength} 个字符。`);
  }

  if (compatibilityControlCharacterPattern.test(trimmed)) {
    errors.push(`${label}包含不可见控制字符，请删除后重试。`);
  } else if (!compatibilityMeaningfulTextPattern.test(trimmed) || !compatibilityTextPattern.test(trimmed)) {
    errors.push(`${label}格式不正确，请使用中英文、数字、空格或 . _ + - / () 等常用字符。`);
  }

  return trimmed;
}

function validateCompatibilityNotes(value: string, errors: string[]): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.length > 500) {
    errors.push('备注不能超过 500 个字符。');
  }

  if (compatibilityControlCharacterPattern.test(trimmed)) {
    errors.push('备注包含不可见控制字符，请删除后重试。');
  }

  return trimmed;
}

function detectOsName(userAgent: string): CompatibilityOsName {
  const normalized = userAgent.toLowerCase();

  if (normalized.includes('harmonyos') || normalized.includes('huawei')) {
    return 'HarmonyOS';
  }

  if (normalized.includes('android')) {
    return 'Android';
  }

  return 'Other';
}

function detectBrowserName(userAgent: string): string {
  if (/EdgA?\//.test(userAgent)) {
    return 'Edge';
  }

  if (/HuaweiBrowser\//.test(userAgent)) {
    return '华为浏览器';
  }

  if (/HeyTapBrowser\//.test(userAgent) || /OppoBrowser\//.test(userAgent)) {
    return '系统浏览器';
  }

  if (/Chrome\//.test(userAgent)) {
    return 'Chrome';
  }

  return '';
}

function toApiUrl(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  const normalizedBase = apiBaseUrl.replace(/\/$/, '');
  const normalizedValue = value.startsWith('/') ? value : `/${value}`;

  if (!normalizedBase) {
    return normalizedValue;
  }

  if (
    normalizedBase.startsWith('/') &&
    (normalizedValue === normalizedBase || normalizedValue.startsWith(`${normalizedBase}/`))
  ) {
    return normalizedValue;
  }

  return `${normalizedBase}${normalizedValue}`;
}

function createAuthHeaders(session: AuthSession): Record<string, string> {
  return session.token ? { Authorization: `Bearer ${session.token}` } : {};
}

async function fetchCurrentAuthSession(): Promise<AuthSession | null> {
  const response = await fetch(toApiUrl('/api/v1/auth/session'), {
    cache: 'no-store',
    credentials: 'include',
  });
  const payload = (await response.json().catch(() => null)) as { user?: AuthUser } | null;

  if (!response.ok || !payload?.user) {
    return null;
  }

  return {
    user: payload.user,
  };
}

function resolveGenerationResource(user: AuthUser, mode: ConversionDraft['mode']): GenerationResource {
  if (user.planType === 'pro') {
    return mode === 'cloud' ? 'pro-cloud' : 'pro-local';
  }

  return 'free-local';
}

function isUnlimitedUsage(usage: AuthUsageSummary | null | undefined): boolean {
  return Boolean(usage && (usage.quotaLimit < 0 || usage.remainingToday < 0));
}

function formatQuotaValue(usage: AuthUsageSummary | null | undefined): string {
  if (!usage) {
    return '-';
  }

  return isUnlimitedUsage(usage) ? '无限' : `${usage.remainingToday}/${usage.quotaLimit}`;
}

function formatQuotaDetail(usage: AuthUsageSummary | null | undefined): string {
  if (!usage) {
    return '登录后同步额度';
  }

  return isUnlimitedUsage(usage) ? `永久会员，已用 ${usage.usedToday} 次` : `已用 ${usage.usedToday} 次`;
}

function formatPlanLabel(session: AuthSession | null): string {
  if (!session) {
    return '未登录';
  }

  if (session.user.planType === 'pro') {
    return session.user.dailyQuota < 0 ? '永久VIP' : 'VIP';
  }

  return '免费版';
}

function formatPlanBadge(user: AuthUser): string {
  if (user.planType === 'pro') {
    return user.dailyQuota < 0 ? '永久VIP' : 'VIP';
  }

  return '免费版';
}

function formatUserCreatedDate(user: AuthUser): string {
  const createdDate = new Date(user.createdAt);

  if (Number.isNaN(createdDate.getTime())) {
    return '-';
  }

  return createdDate.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function createCloudQuery(draft: ConversionDraft): string {
  const query = new URLSearchParams({
    presetId: draft.presetId,
    aspectRatioId: draft.aspectRatioId,
    fitMode: draft.fitMode,
    backgroundColor: draft.backgroundColor,
    rotationDegrees: draft.rotationDegrees.toString(),
    flipHorizontal: draft.flipHorizontal ? 'true' : 'false',
    flipVertical: draft.flipVertical ? 'true' : 'false',
    brightness: draft.brightness.toString(),
    contrast: draft.contrast.toString(),
    saturation: draft.saturation.toString(),
    startSeconds: draft.startSeconds.toString(),
    endSeconds: draft.endSeconds.toString(),
    keyframeSeconds: draft.keyframeSeconds.toString(),
    muted: draft.muted ? 'true' : 'false',
  });

  return query.toString();
}

function getTargetClipDuration(preset: ExportPreset, sourceDurationSeconds: number | null | undefined): number {
  const sourceDuration = sourceDurationSeconds ?? preset.maxDurationSeconds;
  return Math.max(productLimits.minDurationSeconds, Math.min(sourceDuration, preset.maxDurationSeconds));
}

function createKeyframeSuggestions(startSeconds: number, endSeconds: number, metadata: VideoMetadata | null): KeyframeSuggestion[] {
  const duration = Math.max(0, endSeconds - startSeconds);

  if (!metadata || duration < productLimits.minDurationSeconds) {
    return [];
  }

  const verticalBonus = metadata?.height && metadata.width && metadata.height > metadata.width ? 8 : 0;
  const at = (ratio: number) => Math.round((startSeconds + duration * ratio) * 10) / 10;

  return [
    {
      seconds: at(0.5),
      score: 86 + verticalBonus,
      reasons: ['片段中点稳定', '默认封面候选'],
    },
    {
      seconds: at(0.38),
      score: 78,
      reasons: ['避开开头黑场', '保留动作起势'],
    },
    {
      seconds: at(0.68),
      score: 74 + verticalBonus,
      reasons: ['避开结尾停顿', '适合动态照片复测'],
    },
  ].sort((left, right) => right.score - left.score);
}

export function VidLiveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [draft, setDraft] = useState<ConversionDraft>(initialDraft);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [previewPlaybackFailed, setPreviewPlaybackFailed] = useState(false);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);

  const syncMetadataDuration = useCallback((videoDuration: number) => {
    if (Number.isFinite(videoDuration) && videoDuration > 0) {
      setMetadata((current) => {
        if (!current || current.durationSeconds === videoDuration) {
          return current;
        }
        return {
          ...current,
          durationSeconds: videoDuration,
        };
      });
    }
  }, []);
  const [failureReason, setFailureReason] = useState<FailureReason | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [generationFeedbackAvailable, setGenerationFeedbackAvailable] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [exportResult, setExportResult] = useState<LocalExportResult | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [cloudConsentConfirmed, setCloudConsentConfirmed] = useState(false);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [compatibilityDialogOpen, setCompatibilityDialogOpen] = useState(false);
  const [lastSuccessfulDownload, setLastSuccessfulDownload] = useState<CompatibilityDownloadContext | null>(null);
  const [downloadBusySource, setDownloadBusySource] = useState<CloudDownloadRequest['source'] | null>(null);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [generationAccessDialogOpen, setGenerationAccessDialogOpen] = useState(false);
  const [generationAccess, setGenerationAccess] = useState<GenerationAccessState | null>(null);
  const [isCheckingGenerationAccess, setIsCheckingGenerationAccess] = useState(false);
  const [isConsumingGenerationQuota, setIsConsumingGenerationQuota] = useState(false);

  const clearGenerationFeedback = useCallback((closeDialog = true) => {
    setExportResult(null);
    setCloudJob(null);
    setGenerationProgress(0);
    setGenerationFeedbackAvailable(false);
    setFailureReason(null);

    if (closeDialog) {
      setGenerationDialogOpen(false);
    }
  }, []);

  const openCompatibilityLab = useCallback((context: Omit<CompatibilityDownloadContext, 'downloadedAt'>) => {
    setLastSuccessfulDownload({
      ...context,
      downloadedAt: new Date().toISOString(),
    });
    setCompatibilityDialogOpen(true);
  }, []);

  const handleAuthSuccess = useCallback((session: AuthSession) => {
    setAuthSession(session);
    setAuthDialogOpen(false);
    setGenerationAccess(null);
    setGenerationAccessDialogOpen(false);
  }, []);

  const handleLogout = useCallback(() => {
    void fetch(toApiUrl('/api/v1/auth/logout'), {
      method: 'POST',
      credentials: 'include',
    });
    setAuthSession(null);
    setLogoutConfirmOpen(false);
    setGenerationAccess(null);
    setGenerationAccessDialogOpen(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetchCurrentAuthSession()
      .then((session) => {
        if (!cancelled) {
          setAuthSession(session);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAuthSession(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCloudJob = useCallback(async (jobId: string): Promise<CloudJob | null> => {
    let response: Response;

    try {
      response = await fetch(toApiUrl(`/api/conversions/cloud-jobs/${jobId}`), {
        cache: 'no-store',
      });
    } catch {
      setFailureReason('cloud-timeout');
      return null;
    }

    if (!response.ok) {
      setFailureReason(response.status === 404 ? 'expired-link' : 'cloud-timeout');
      setGenerationProgress(0);
      return null;
    }

    const nextJob = (await response.json()) as CloudJob;
    setCloudJob(nextJob);
    setGenerationProgress(nextJob.progress);

    if (nextJob.status === 'failed') {
      setFailureReason('cloud-timeout');
    }

    if (nextJob.status === 'expired') {
      setFailureReason('expired-link');
    }

    return nextJob;
  }, []);

  const pollCloudJobUntilSettled = useCallback(
    async (jobId: string) => {
      let nextJob = await refreshCloudJob(jobId);

      while (nextJob && isCloudJobActive(nextJob)) {
        await sleep(1_500);
        nextJob = await refreshCloudJob(jobId);
      }
    },
    [refreshCloudJob],
  );

  useEffect(() => {
    if (!previewUrl || !file || isGif(file)) {
      return;
    }

    let cancelled = false;
    const coverTimer = window.setTimeout(() => {
      captureCoverFrame(previewUrl, draft.keyframeSeconds).then((frame) => {
        if (!cancelled) {
          setCoverUrl(frame);
          setPreviewPlaybackFailed((current) => current || !frame);
        }
      }).catch(() => {
        if (!cancelled) {
          setCoverUrl(null);
          setPreviewPlaybackFailed(true);
        }
      });
    }, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(coverTimer);
    };
  }, [draft.keyframeSeconds, file, previewUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reconcile draft limits after metadata/preset changes.
    setDraft((current) => {
      const preset = exportPresets[current.presetId];
      const sourceDurationMax = Math.max(productLimits.minDurationSeconds, metadata?.durationSeconds ?? preset.maxDurationSeconds);
      const clipTargetDuration = getTargetClipDuration(preset, sourceDurationMax);
      const nextStart = clamp(current.startSeconds, 0, Math.max(0, sourceDurationMax - clipTargetDuration));
      const nextEnd = nextStart + clipTargetDuration;
      const nextKeyframe = clamp(current.keyframeSeconds, nextStart, nextEnd);

      if (
        nextStart === current.startSeconds &&
        nextEnd === current.endSeconds &&
        nextKeyframe === current.keyframeSeconds
      ) {
        return current;
      }

      return {
        ...current,
        startSeconds: nextStart,
        endSeconds: nextEnd,
        keyframeSeconds: nextKeyframe,
      };
    });
  }, [metadata?.durationSeconds]);

  const acceptedMimeTypes = useMemo(() => {
    return supportedInputs.reduce<Record<string, string[]>>((accumulator, input) => {
      for (const mimeType of input.mimeTypes) {
        accumulator[mimeType] = [`.${input.extension}`];
      }

      return accumulator;
    }, {});
  }, []);

  const handleDrop = useCallback(
    async (acceptedFiles: File[], rejections: FileRejection[]) => {
      const rejectionReason = getDropError(rejections);

      if (rejectionReason) {
        clearGenerationFeedback();
        setFailureReason(rejectionReason);
        return;
      }

      const selectedFile = acceptedFiles[0];

      if (!selectedFile || !isSupportedInput(selectedFile)) {
        clearGenerationFeedback();
        setFailureReason('unsupported-format');
        return;
      }

      setIsReading(true);
      setFailureReason(null);
      setCoverUrl(null);
      setPreviewPlaybackFailed(false);
      setPlayheadSeconds(0);
      clearGenerationFeedback();
      setCloudConsentConfirmed(false);

      const objectUrl = URL.createObjectURL(selectedFile);

      try {
        const nextMetadata = isGif(selectedFile)
          ? inspectImageLikeFile(selectedFile)
          : await inspectVideoFile(selectedFile, objectUrl);
        const shouldUseCloud = selectedFile.size > productLimits.localFileSizeBytes;
        const nextPresetId = shouldUseCloud ? 'standard-live-photo' : draft.presetId;

        setFile(selectedFile);
        setMetadata(nextMetadata);
        setPreviewUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }

          return objectUrl;
        });
        setDraft((current) => ({
          ...getDefaultDraftForPreset(nextPresetId, current, nextMetadata),
          mode: shouldUseCloud ? 'cloud' : 'local',
        }));
      } catch {
        if (isGif(selectedFile)) {
          URL.revokeObjectURL(objectUrl);
          setFailureReason('metadata-read-failed');
          return;
        }

        const containerMetadata = await inspectMp4ContainerFile(selectedFile).catch(() => null);
        const fallbackMetadata = containerMetadata ?? createCloudFallbackMetadata(selectedFile, draft.presetId);

        setFile(selectedFile);
        setMetadata(fallbackMetadata);
        setPreviewUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }

          return objectUrl;
        });
        setDraft((current) => ({
          ...getDefaultDraftForPreset(draft.presetId, current, fallbackMetadata),
          mode: 'cloud',
        }));
        setFailureReason('cloud-required');
      } finally {
        setIsReading(false);
      }
    },
    [clearGenerationFeedback, draft.presetId],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: acceptedMimeTypes,
    maxSize: productLimits.cloudFileSizeBytes,
    multiple: false,
    noClick: true,
    noKeyboard: true,
    onDrop: handleDrop,
  });

  const selectedPreset = exportPresets[draft.presetId];
  const sourceDurationMax = Math.max(
    productLimits.minDurationSeconds,
    metadata?.durationSeconds ?? selectedPreset.maxDurationSeconds,
  );
  const clipTargetDuration = getTargetClipDuration(selectedPreset, sourceDurationMax);
  const startMax = Math.max(0, sourceDurationMax - clipTargetDuration);
  const keyframeSuggestions = useMemo(
    () => createKeyframeSuggestions(draft.startSeconds, draft.endSeconds, metadata),
    [draft.endSeconds, draft.startSeconds, metadata],
  );
  const currentFailure = failureReason ? failureAdvice[failureReason] : null;
  const clipDuration = Math.max(0, draft.endSeconds - draft.startSeconds);
  const currentPlayheadSeconds = clamp(playheadSeconds, 0, sourceDurationMax);
  const cloudBusy = isCloudJobActive(cloudJob);
  const cloudConsentRequired = draft.mode === 'cloud' && !cloudConsentConfirmed;
  const canGenerate = Boolean(
    file &&
      previewUrl &&
      metadata &&
      !isReading &&
      !isGenerating &&
      !cloudBusy &&
      !cloudConsentRequired &&
      disclaimerAccepted &&
      !isCheckingGenerationAccess &&
      !isConsumingGenerationQuota,
  );
  const packageArtifact = exportResult?.artifacts.find((artifact) => artifact.kind === 'package') ?? null;
  const hasGenerationOutput = Boolean(exportResult || cloudJob);
  const hasCompletedGenerationOutput = Boolean(exportResult || cloudJob?.status === 'completed');
  const generationFailed = Boolean(
    generationFeedbackAvailable &&
      !isGenerating &&
      !cloudBusy &&
      ((currentFailure && !hasCompletedGenerationOutput) ||
        cloudJob?.status === 'failed' ||
        cloudJob?.status === 'expired'),
  );
  const generationStatus = isGenerating || cloudBusy ? 'generating' : generationFailed ? 'failed' : 'complete';
  const shouldShowGenerationTrigger = Boolean(
    generationFeedbackAvailable || isGenerating || cloudBusy || generationProgress > 0 || hasGenerationOutput,
  );
  const cloudDownloadUrl = cloudJob?.artifact ? toApiUrl(cloudJob.artifact.downloadUrl) : null;
  const androidMotionPhotoUrl = cloudJob?.androidMotionPhoto ? toApiUrl(cloudJob.androidMotionPhoto.downloadUrl) : null;
  const previewPhotoUrl = cloudJob?.previewPhoto ? toApiUrl(cloudJob.previewPhoto.downloadUrl) : null;

  const updatePreset = (presetId: ExportPresetId) => {
    clearGenerationFeedback();
    setDraft((current) => getDefaultDraftForPreset(presetId, current, metadata));
  };

  const updateStart = (value: number) => {
    clearGenerationFeedback();
    setDraft((current) => {
      const nextStart = clamp(value, 0, Math.max(0, sourceDurationMax - current.clipDurationSeconds));
      const nextEnd = nextStart + current.clipDurationSeconds;
      const nextKeyframe = clamp(current.keyframeSeconds, nextStart, nextEnd);

      return {
        ...current,
        startSeconds: nextStart,
        endSeconds: nextEnd,
        keyframeSeconds: nextKeyframe,
      };
    });
  };

  const updateClipDuration = (value: number) => {
    clearGenerationFeedback();
    setDraft((current) => {
      const nextDuration = clamp(value, productLimits.livePhotoMinDurationSeconds, productLimits.livePhotoMaxDurationSeconds);
      const nextStart = clamp(current.startSeconds, 0, Math.max(0, sourceDurationMax - nextDuration));
      const nextEnd = nextStart + nextDuration;
      const nextKeyframe = clamp(current.keyframeSeconds, nextStart, nextEnd);

      return {
        ...current,
        clipDurationSeconds: nextDuration,
        startSeconds: nextStart,
        endSeconds: nextEnd,
        keyframeSeconds: nextKeyframe,
      };
    });
  };

  const updateKeyframe = (value: number) => {
    clearGenerationFeedback();
    setDraft((current) => ({
      ...current,
      keyframeSeconds: clamp(value, current.startSeconds, current.endSeconds),
    }));
  };

  const downloadLocalArtifact = (artifact: LocalExportArtifact) => {
    downloadBlob(artifact.blob, artifact.fileName);
    openCompatibilityLab({
      fileName: artifact.fileName,
      source: 'local-export',
    });
  };

  const downloadCloudArtifact = async ({
    url,
    fileName,
    source,
  }: {
    url: string;
    fileName: string;
    source: 'android-motion-photo' | 'cloud-package';
  }) => {
    setDownloadBusySource(source);
    setFailureReason(null);

    try {
      const response = await fetch(url, { cache: 'no-store' });

      if (!response.ok) {
        setFailureReason(response.status === 404 ? 'expired-link' : 'cloud-timeout');
        return;
      }

      const blob = await response.blob();
      downloadBlob(blob, fileName);
      openCompatibilityLab({
        fileName,
        source,
      });
    } catch {
      setFailureReason('cloud-timeout');
    } finally {
      setDownloadBusySource(null);
    }
  };

  const runGeneration = async () => {
    if (!file || !previewUrl || !metadata) {
      clearGenerationFeedback();
      setFailureReason('metadata-read-failed');
      return;
    }

    if (draft.mode === 'cloud' && !cloudConsentConfirmed) {
      clearGenerationFeedback();
      setFailureReason('cloud-required');
      return;
    }

    // 手机端 range input 的 onChange/onInput 可能不触发或延迟触发
    // 生成前强制从 DOM 读取实际值并同步到 state
    // 等待一小段时间确保浏览器完成渲染和值更新
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startInput = document.getElementById('timeline-start-seconds') as HTMLInputElement | null;
    const keyframeInput = document.getElementById('timeline-keyframe-seconds') as HTMLInputElement | null;

    if (startInput) {
      const domStartValue = Number(startInput.value);
      if (!Number.isNaN(domStartValue) && domStartValue !== draft.startSeconds) {
        updateStart(domStartValue);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    if (keyframeInput) {
      const domKeyframeValue = Number(keyframeInput.value);
      if (!Number.isNaN(domKeyframeValue) && domKeyframeValue !== draft.keyframeSeconds) {
        updateKeyframe(domKeyframeValue);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    setFailureReason(null);
    setGenerationFeedbackAvailable(true);
    setExportResult(null);
    setCloudJob(null);
    setGenerationDialogOpen(true);
    setIsGenerating(true);
    setGenerationProgress(draft.mode === 'cloud' ? 3 : 4);

    let stopEstimatedProgress: (() => void) | null = null;

    try {
      if (draft.mode === 'cloud') {
        setGenerationProgress(6);
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(toApiUrl(`/api/conversions/cloud-jobs?${createCloudQuery(draft)}`), {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          setGenerationProgress(0);
          setFailureReason(response.status === 413 ? 'file-too-large' : 'cloud-timeout');
          return;
        }

        const nextJob = (await response.json()) as CloudJob;
        setGenerationFeedbackAvailable(true);
        setCloudJob(nextJob);
        setGenerationProgress(Math.max(10, nextJob.progress));
        await pollCloudJobUntilSettled(nextJob.id);
        return;
      }

      setGenerationProgress(8);
      await sleep(120);
      setGenerationProgress(14);
      stopEstimatedProgress = startEstimatedLocalProgress(setGenerationProgress);
      const result = await generateLocalExport(file, previewUrl, draft, metadata);
      stopEstimatedProgress();
      stopEstimatedProgress = null;
      setGenerationProgress(94);
      await sleep(120);
      setGenerationProgress(100);
      setGenerationFeedbackAvailable(true);
      setExportResult(result);
    } catch (error) {
      setGenerationProgress(0);
      setGenerationFeedbackAvailable(true);
      setFailureReason(draft.mode === 'cloud' ? 'cloud-timeout' : getFailureFromExportError(error));
    } finally {
      stopEstimatedProgress?.();
      setIsGenerating(false);
    }
  };

  const handleGenerateClick = async () => {
    if (!file || !previewUrl || !metadata) {
      clearGenerationFeedback();
      setFailureReason('metadata-read-failed');
      return;
    }

    if (draft.mode === 'cloud' && !cloudConsentConfirmed) {
      clearGenerationFeedback();
      setFailureReason('cloud-required');
      return;
    }

    if (!authSession) {
      setGenerationAccess({
        kind: 'auth-required',
        usage: null,
        resource: null,
        message: '登录后才能生成安卓实况图，系统会按账号版本校验今日导出额度。',
      });
      setGenerationAccessDialogOpen(true);
      return;
    }

    setIsCheckingGenerationAccess(true);
    setGenerationAccess(null);

    try {
      const response = await fetch(toApiUrl('/api/v1/auth/session'), {
        cache: 'no-store',
        credentials: 'include',
        headers: createAuthHeaders(authSession),
      });
      const payload = (await response.json().catch(() => null)) as
        | { user?: AuthUser; usage?: AuthUsageSummary; message?: string }
        | null;

      if (!response.ok) {
        setGenerationAccess({
          kind: 'error',
          usage: null,
          resource: null,
          message: payload?.message ?? '导出额度校验失败，请稍后再试。',
        });
        setGenerationAccessDialogOpen(true);
        return;
      }

      if (!payload?.user) {
        setAuthSession(null);
        setGenerationAccess({
          kind: 'auth-required',
          usage: null,
          resource: null,
          message: '登录状态已失效，请重新登录后再生成。',
        });
        setGenerationAccessDialogOpen(true);
        return;
      }

      if (!payload.usage) {
        setGenerationAccess({
          kind: 'error',
          usage: null,
          resource: null,
          message: payload?.message ?? '导出额度校验失败，请稍后再试。',
        });
        setGenerationAccessDialogOpen(true);
        return;
      }

      const nextSession = {
        ...authSession,
        user: payload.user,
      };
      const resource = resolveGenerationResource(payload.user, draft.mode);

      setAuthSession(nextSession);

      // 不再限制免费用户使用云端模式，改为检查云端配额
      if (draft.mode === 'cloud' && !isUnlimitedUsage(payload.usage) && payload.usage.cloudRemaining <= 0) {
        setGenerationAccess({
          kind: 'quota-exhausted',
          usage: payload.usage,
          resource: null,
          message: '今日云端生成额度已用完，可改用本地生成或明天再试。',
        });
        setGenerationAccessDialogOpen(true);
        return;
      }

      if (draft.mode === 'local' && !isUnlimitedUsage(payload.usage) && payload.usage.localRemaining <= 0) {
        setGenerationAccess({
          kind: 'quota-exhausted',
          usage: payload.usage,
          resource: null,
          message: '今日本地生成额度已用完，可改用云端生成或明天再试。',
        });
        setGenerationAccessDialogOpen(true);
        return;
      }

      if (!isUnlimitedUsage(payload.usage) && payload.usage.remainingToday <= 0) {
        setGenerationAccess({
          kind: 'quota-exhausted',
          usage: payload.usage,
          resource,
          message: '今日导出额度已用完，请明天再试或升级专业版。',
        });
        setGenerationAccessDialogOpen(true);
        return;
      }

      setGenerationAccess({
        kind: 'ready',
        usage: payload.usage,
        resource,
      });
      setGenerationAccessDialogOpen(true);
    } catch {
      setGenerationAccess({
        kind: 'error',
        usage: null,
        resource: null,
        message: '账号服务暂时不可用，请确认后端服务已启动。',
      });
      setGenerationAccessDialogOpen(true);
    } finally {
      setIsCheckingGenerationAccess(false);
    }
  };

  const confirmGenerateWithQuota = async () => {
    if (!authSession || generationAccess?.kind !== 'ready') {
      return;
    }

    setIsConsumingGenerationQuota(true);

    try {
      const response = await fetch(toApiUrl('/api/v1/usage/conversions'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...createAuthHeaders(authSession),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          presetId: draft.presetId,
          mode: draft.mode,
          resource: generationAccess.resource,
        }),
      });
      const payload = (await response.json().catch(() => null)) as AuthUsageSummary | { message?: string } | null;

      if (response.status === 401) {
        setAuthSession(null);
        setGenerationAccess({
          kind: 'auth-required',
          usage: null,
          resource: null,
          message: '登录状态已失效，请重新登录后再生成。',
        });
        return;
      }

      if (response.status === 429) {
        setGenerationAccess({
          kind: 'quota-exhausted',
          usage: generationAccess.usage,
          resource: generationAccess.resource,
          message: '今日导出额度刚刚用完，请明天再试或升级专业版。',
        });
        return;
      }

      if (!response.ok) {
        setGenerationAccess({
          kind: 'error',
          usage: generationAccess.usage,
          resource: generationAccess.resource,
          message: payload && 'message' in payload ? payload.message : '生成额度扣减失败，请稍后再试。',
        });
        return;
      }

      if (payload && 'remainingToday' in payload) {
        setGenerationAccess({
          ...generationAccess,
          usage: payload,
        });

        // 重新获取用户信息以更新显示的配额
        try {
          const updatedSession = await fetchCurrentAuthSession();
          if (updatedSession) {
            setAuthSession(updatedSession);
          }
        } catch {
          // 忽略错误，配额已扣除成功
        }
      }

      setGenerationAccessDialogOpen(false);
      await runGeneration();
    } finally {
      setIsConsumingGenerationQuota(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#fff4df] text-ink">
      <section className="border-b-2 border-ink/10 bg-[#fff4df]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
          <header className="grid gap-3 lg:grid-cols-[auto_minmax(280px,1fr)_auto] lg:items-center">
            <div className="brand-enter inline-flex h-11 items-center gap-2 rounded-lg border-2 border-ink bg-white px-3 shadow-clay-sm">
              <img src="/images/01.webp" alt="" className="h-6 w-6 rounded-md object-cover" />
              <span className="brand-wordmark">VidLive</span>
            </div>

            <SavePathPanel />

            <div className="flex flex-wrap gap-2 lg:justify-end">
              <StatusPill icon={<ShieldCheck size={15} />} label="本地优先" />
              <StatusPill icon={<Clock3 size={15} />} label="1-3 秒实况" />
              <AuthEntryButton
                session={authSession}
                onOpen={() => setAuthDialogOpen(true)}
                onLogout={() => setLogoutConfirmOpen(true)}
              />
            </div>
          </header>

          <div className="grid flex-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="grid min-w-0 gap-5">
              <UploadPanel
                file={file}
                previewUrl={previewUrl}
                draft={draft}
                isReading={isReading}
                isDragActive={isDragActive}
                playbackFailed={previewPlaybackFailed}
                getRootProps={getRootProps}
                getInputProps={getInputProps}
                open={open}
                onPlaybackError={() => setPreviewPlaybackFailed(true)}
                onPlaybackReady={() => setPreviewPlaybackFailed(false)}
                onPlaybackTimeChange={setPlayheadSeconds}
                onMetadataLoaded={syncMetadataDuration}
              />

              {currentFailure && !generationFeedbackAvailable && (
                <FailureNotice title={currentFailure.title} action={currentFailure.action} />
              )}

              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric label="文件" value={metadata?.name ?? '未选择'} tone="coral" />
                <Metric label="大小" value={metadata ? formatBytes(metadata.sizeBytes) : '-'} tone="mint" />
                <Metric label="时长" value={metadata ? formatSeconds(metadata.durationSeconds) : '-'} tone="sun" />
                <Metric
                  label="尺寸"
                  value={metadata?.width && metadata.height ? `${metadata.width} x ${metadata.height}` : '-'}
                  tone="sky"
                />
              </section>

              <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
                <MediaPreview
                  file={file}
                  previewUrl={previewUrl}
                  draft={draft}
                  playbackFailed={previewPlaybackFailed}
                  onPlaybackError={() => setPreviewPlaybackFailed(true)}
                  onPlaybackReady={() => setPreviewPlaybackFailed(false)}
                  onPlaybackTimeChange={setPlayheadSeconds}
                  onMetadataLoaded={syncMetadataDuration}
                />
                <CoverPreview coverUrl={coverUrl} isGif={Boolean(file && isGif(file))} open={open} aspectRatioId={draft.aspectRatioId} />
              </section>

              <section className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
                <Panel title="时间轴" icon={<Scissors size={18} />}>
                  <div className="mb-3 rounded-lg border-2 border-ink/15 bg-white p-3">
                    <div className="mb-2 flex items-center justify-between gap-3 text-sm font-bold text-ink/70">
                      <span>播放位置</span>
                      <span className="font-mono text-xs text-ink">{formatSeconds(currentPlayheadSeconds)}</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <TimelineMarkButton
                        label="设为起点"
                        disabled={!file || Boolean(file && isGif(file))}
                        onClick={() => updateStart(currentPlayheadSeconds)}
                      />
                      <TimelineMarkButton
                        label="设为关键帧"
                        disabled={!file || Boolean(file && isGif(file))}
                        onClick={() => updateKeyframe(currentPlayheadSeconds)}
                      />
                    </div>
                  </div>
                  <RangeField
                    id="timeline-start-seconds"
                    label="起点"
                    value={draft.startSeconds}
                    min={0}
                    max={startMax}
                    step={0.1}
                    onChange={updateStart}
                  />
                  <RangeField
                    id="timeline-clip-duration"
                    label="实况时长"
                    value={draft.clipDurationSeconds}
                    min={productLimits.livePhotoMinDurationSeconds}
                    max={productLimits.livePhotoMaxDurationSeconds}
                    step={0.1}
                    onChange={updateClipDuration}
                  />
                  {draft.startSeconds + draft.clipDurationSeconds > sourceDurationMax && (
                    <div className="mb-3 rounded-lg border-2 border-amber-600 bg-amber-50 px-3 py-2">
                      <div className="flex items-start gap-2">
                        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-600" />
                        <div className="flex-1 text-xs">
                          <p className="font-bold text-amber-900">时长超出素材范围</p>
                          <p className="mt-1 text-amber-800">
                            起点 {formatSeconds(draft.startSeconds)} + 时长 {formatSeconds(draft.clipDurationSeconds)} 超出素材总长 {formatSeconds(sourceDurationMax)}，已自动调整起点。
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  <ReadonlyTimelineField
                    label="终点"
                    value={draft.endSeconds}
                    hint={`起点 + ${formatSeconds(draft.clipDurationSeconds)}`}
                  />
                  <RangeField
                    id="timeline-keyframe-seconds"
                    label="关键帧"
                    value={draft.keyframeSeconds}
                    min={draft.startSeconds}
                    max={draft.endSeconds}
                    step={0.1}
                    onChange={updateKeyframe}
                  />
                  <p className="mt-2 rounded-lg border border-ink/10 bg-[#fff4df] px-3 py-2 text-xs font-bold text-ink/65">
                    素材总长：{formatSeconds(sourceDurationMax)} / 当前片段：{formatSeconds(clipDuration)}
                  </p>
                </Panel>

                {keyframeSuggestions.length > 0 && (
                  <Panel title="关键帧建议" icon={<ImageIcon size={18} />}>
                    <div className="grid gap-2">
                      {keyframeSuggestions.map((suggestion) => (
                        <button
                          key={suggestion.seconds}
                          type="button"
                          onClick={() => updateKeyframe(suggestion.seconds)}
                          className="rounded-lg border-2 border-ink/15 bg-white p-3 text-left transition hover:border-ink"
                        >
                          <span className="flex items-center justify-between gap-3 text-sm font-black text-ink">
                            <span>{formatSeconds(suggestion.seconds)}</span>
                            <span className="text-xs text-[#23b7a4]">{suggestion.score}</span>
                          </span>
                          <span className="mt-1 block text-xs font-semibold leading-5 text-ink/60">
                            {suggestion.reasons.join(' / ')}
                          </span>
                        </button>
                      ))}
                    </div>
                  </Panel>
                )}
              </section>

            </div>

            <aside className="flex min-w-0 flex-col gap-4">
              <SidebarInfoCarousel />

              <Panel title="处理模式" icon={<CloudOff size={18} />}>
                <div className="grid grid-cols-2 gap-2">
                  <ModeButton
                    active={draft.mode === 'local'}
                    label="本地"
                    description="不上传素材"
                    tooltip={modeHelpText.local}
                    onClick={() => {
                      clearGenerationFeedback();
                      setCloudConsentConfirmed(false);
                      setDraft((current) => ({ ...current, mode: 'local' }));
                      setFailureReason(null);
                    }}
                  />
                  <ModeButton
                    active={draft.mode === 'cloud'}
                    label="云端"
                    description="安卓实况图"
                    tooltip={modeHelpText.cloud}
                    onClick={() => {
                      clearGenerationFeedback();
                      setCloudConsentConfirmed(false);
                      setDraft((current) => ({ ...current, mode: 'cloud' }));
                      setFailureReason(null);
                    }}
                  />
                </div>
              </Panel>

              <Panel title="导出预设" icon={<Download size={18} />}>
                <div className="grid gap-2">
                  {(Object.keys(exportPresets) as ExportPresetId[]).map((presetId) => (
                    <PresetButton
                      key={presetId}
                      active={draft.presetId === presetId}
                      presetId={presetId}
                      onClick={() => updatePreset(presetId)}
                    />
                  ))}
                </div>
              </Panel>

              <Panel title="画面与声音" icon={<SlidersHorizontal size={18} />}>
                <div className="grid grid-cols-3 gap-2">
                  {aspectRatios.map((ratio) => (
                    <button
                      key={ratio.id}
                      type="button"
                      onClick={() => {
                        clearGenerationFeedback();
                        setDraft((current) => ({ ...current, aspectRatioId: ratio.id }));
                      }}
                      className={[
                        'h-10 rounded-lg border-2 px-2 text-sm font-black transition',
                        draft.aspectRatioId === ratio.id
                          ? 'border-ink bg-[#f7c948] shadow-clay-sm'
                          : 'border-ink/15 bg-white text-ink/70 hover:border-ink',
                      ].join(' ')}
                    >
                      {ratio.label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <ToggleButton
                    active={draft.fitMode === 'cover'}
                    label="裁切填满"
                    onClick={() => {
                      clearGenerationFeedback();
                      setDraft((current) => ({ ...current, fitMode: 'cover' as FitMode }));
                    }}
                  />
                  <ToggleButton
                    active={draft.fitMode === 'contain'}
                    label="补背景"
                    onClick={() => {
                      clearGenerationFeedback();
                      setDraft((current) => ({ ...current, fitMode: 'contain' as FitMode }));
                    }}
                  />
                </div>
                <div className="mt-3">
                  <span className="mb-2 flex items-center gap-2 text-sm font-bold text-ink/70">
                    <Palette size={15} />
                    背景色
                  </span>
                  <div className="grid grid-cols-5 gap-2">
                    {backgroundColorOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        aria-label={`背景色 ${option.label}`}
                        title={option.label}
                        onClick={() => {
                          clearGenerationFeedback();
                          setDraft((current) => ({ ...current, backgroundColor: option.value }));
                        }}
                        className={[
                          'h-9 rounded-lg border-2 shadow-clay-sm transition hover:-translate-y-0.5',
                          draft.backgroundColor === option.value ? 'border-ink' : 'border-ink/15',
                        ].join(' ')}
                        style={{ backgroundColor: option.value }}
                      >
                        <span className="sr-only">{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    clearGenerationFeedback();
                    setDraft((current) => ({ ...current, muted: !current.muted }));
                  }}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border-2 border-ink/15 bg-white text-sm font-black text-ink transition hover:border-ink"
                >
                  {draft.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  {draft.muted ? '静音' : '保留声音'}
                </button>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <ToggleButton
                    active={draft.rotationDegrees !== 0}
                    label={`${draft.rotationDegrees}°`}
                    onClick={() => {
                      clearGenerationFeedback();
                      setDraft((current) => ({
                        ...current,
                        rotationDegrees: (((current.rotationDegrees + 90) % 360) as 0 | 90 | 180 | 270),
                      }));
                    }}
                  />
                  <ToggleButton
                    active={draft.flipHorizontal}
                    label="水平翻转"
                    onClick={() => {
                      clearGenerationFeedback();
                      setDraft((current) => ({ ...current, flipHorizontal: !current.flipHorizontal }));
                    }}
                  />
                  <ToggleButton
                    active={draft.flipVertical}
                    label="垂直翻转"
                    onClick={() => {
                      clearGenerationFeedback();
                      setDraft((current) => ({ ...current, flipVertical: !current.flipVertical }));
                    }}
                  />
                </div>
                <NumberRangeField
                  label="亮度"
                  value={draft.brightness}
                  min={50}
                  max={150}
                  step={5}
                  suffix="%"
                  onChange={(value) => {
                    clearGenerationFeedback();
                    setDraft((current) => ({ ...current, brightness: value }));
                  }}
                />
                <NumberRangeField
                  label="对比度"
                  value={draft.contrast}
                  min={50}
                  max={150}
                  step={5}
                  suffix="%"
                  onChange={(value) => {
                    clearGenerationFeedback();
                    setDraft((current) => ({ ...current, contrast: value }));
                  }}
                />
                <NumberRangeField
                  label="饱和度"
                  value={draft.saturation}
                  min={0}
                  max={200}
                  step={5}
                  suffix="%"
                  onChange={(value) => {
                    clearGenerationFeedback();
                    setDraft((current) => ({ ...current, saturation: value }));
                  }}
                />
              </Panel>

              {draft.mode === 'cloud' && (
                <label className="flex items-start gap-3 rounded-lg border-2 border-ink bg-[#e4f7ff] p-3 text-sm font-bold text-ink shadow-clay-sm">
                  <input
                    type="checkbox"
                    checked={cloudConsentConfirmed}
                    onChange={(event) => setCloudConsentConfirmed(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-[#23b7a4]"
                  />
                  <span>
                    云端上传确认：同意上传当前素材生成安卓实况图，临时文件保留 24 小时，可在任务完成后手动删除。
                  </span>
                </label>
              )}

              <label className="flex items-start gap-3 rounded-lg border-2 border-ink bg-[#fff4df] p-3 text-sm font-bold text-ink shadow-clay-sm">
                <input
                  type="checkbox"
                  checked={disclaimerAccepted}
                  onChange={(event) => setDisclaimerAccepted(event.target.checked)}
                  className="mt-1 h-4 w-4 accent-[#23b7a4]"
                />
                <span>
                  我已阅读并同意《免责声明》：本工具仅供学习研究使用，我确认拥有素材的合法使用权，不会用于任何违法用途，并自行承担使用责任。
                </span>
              </label>

              <button
                type="button"
                disabled={!canGenerate}
                onClick={handleGenerateClick}
                className="sticky bottom-3 z-20 inline-flex h-12 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40 lg:static"
              >
                {isGenerating ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
                {isGenerating
                  ? draft.mode === 'cloud'
                    ? '生成实况图'
                    : '正在生成'
                  : draft.mode === 'cloud'
                    ? '生成安卓实况图'
                    : '生成导出包'}
              </button>
            </aside>
          </div>

          <CompatibilityLabTriggerButton
            reportCountLabel={lastSuccessfulDownload ? '已下载' : '众测'}
            onClick={() => setCompatibilityDialogOpen(true)}
          />
          {shouldShowGenerationTrigger && (
            <GenerationStatusButton
              status={generationStatus}
              progress={generationProgress}
              onClick={() => setGenerationDialogOpen(true)}
            />
          )}
          <GenerationDialog
            open={generationDialogOpen && shouldShowGenerationTrigger}
            status={generationStatus}
            mode={draft.mode}
            progress={generationProgress}
            failure={generationFeedbackAvailable ? currentFailure : null}
            cloudJob={cloudJob}
            downloadUrl={cloudDownloadUrl}
            androidMotionPhotoUrl={androidMotionPhotoUrl}
            previewPhotoUrl={previewPhotoUrl}
            exportResult={exportResult}
            packageArtifact={packageArtifact}
            downloadingSource={downloadBusySource}
            aspectRatioId={draft.aspectRatioId}
            onOpenChange={setGenerationDialogOpen}
            onCloudDownload={(download) => {
              void downloadCloudArtifact(download);
            }}
            onLocalDownload={downloadLocalArtifact}
            onDeleteCloudJob={async () => {
              if (!cloudJob) {
                return;
              }

              await fetch(toApiUrl(`/api/conversions/cloud-jobs/${cloudJob.id}`), {
                method: 'DELETE',
              });
              clearGenerationFeedback();
            }}
          />
          <GenerationAccessDialog
            open={generationAccessDialogOpen}
            access={generationAccess}
            session={authSession}
            mode={draft.mode}
            isChecking={isCheckingGenerationAccess}
            isConsuming={isConsumingGenerationQuota}
            onOpenChange={setGenerationAccessDialogOpen}
            onOpenAuth={() => setAuthDialogOpen(true)}
            onUseLocal={() => {
              clearGenerationFeedback();
              setCloudConsentConfirmed(false);
              setDraft((current) => ({ ...current, mode: 'local' }));
              setGenerationAccessDialogOpen(false);
            }}
            onConfirm={() => {
              void confirmGenerateWithQuota();
            }}
          />
          <CompatibilityLabDialog
            open={compatibilityDialogOpen}
            downloadContext={lastSuccessfulDownload}
            onOpenChange={setCompatibilityDialogOpen}
          />
          <AuthDialog
            open={authDialogOpen}
            onOpenChange={setAuthDialogOpen}
            onAuthSuccess={handleAuthSuccess}
          />
          <LogoutConfirmDialog
            open={logoutConfirmOpen && Boolean(authSession)}
            user={authSession?.user ?? null}
            onOpenChange={setLogoutConfirmOpen}
            onConfirm={handleLogout}
          />
        </div>
      </section>
    </main>
  );
}

function UploadPanel({
  file,
  previewUrl,
  draft,
  isReading,
  isDragActive,
  playbackFailed,
  getRootProps,
  getInputProps,
  open,
  onPlaybackError,
  onPlaybackReady,
  onPlaybackTimeChange,
  onMetadataLoaded,
}: {
  file: File | null;
  previewUrl: string | null;
  draft: ConversionDraft;
  isReading: boolean;
  isDragActive: boolean;
  playbackFailed: boolean;
  getRootProps: ReturnType<typeof useDropzone>['getRootProps'];
  getInputProps: ReturnType<typeof useDropzone>['getInputProps'];
  open: () => void;
  onPlaybackError: () => void;
  onPlaybackReady: () => void;
  onPlaybackTimeChange: (seconds: number) => void;
  onMetadataLoaded?: (duration: number) => void;
}) {
  const videoRef = useStartSyncedVideo(draft.startSeconds, onPlaybackTimeChange);

  return (
    <section
      {...getRootProps()}
      className={[
        'clay-card grid min-h-64 gap-4 bg-white p-4 md:grid-cols-[minmax(0,1fr)_220px]',
        isDragActive ? 'bg-[#d9f99d]' : '',
      ].join(' ')}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col justify-between gap-4">
        <div>
          <p className="inline-flex items-center gap-2 rounded-lg border-2 border-ink bg-[#f7c948] px-3 py-2 text-xs font-black shadow-clay-sm">
            <Lock size={15} />
            {draft.mode === 'local' ? '本地模式' : '云端确认'}
          </p>
          <h1 className="mt-5 max-w-2xl text-3xl font-black leading-tight text-ink sm:text-4xl">
            上传、裁剪、选关键帧，生成可下载导出包
          </h1>
          <p className="mt-4 max-w-2xl text-sm font-semibold leading-7 text-ink/68 sm:text-base">
            支持 MP4、MOV、GIF。100MB 内默认本地处理；超过本地上限会提示切换云端处理。
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={open}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#ff715b] px-5 text-sm font-black text-white shadow-clay transition hover:-translate-y-0.5"
          >
            <Upload size={18} />
            选择素材
          </button>
          <div className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#e4f7ff] px-4 text-sm font-black text-ink shadow-clay-sm">
            <ShieldCheck size={17} />
            {isReading ? '读取素材中' : draft.mode === 'cloud' ? '云端保留 24 小时' : '素材不离开浏览器'}
          </div>
        </div>
      </div>
      <div className="relative overflow-hidden rounded-lg border-2 border-ink bg-ink">
        {isReading && <LoadingOverlay message="正在解析文件..." />}
        {previewUrl && file && !isGif(file) && isEdgeBrowser() && (
          <div className="absolute left-0 right-0 top-0 z-10 mx-4 mt-4">
            <div className="rounded-lg border-2 border-amber-600 bg-amber-50 px-4 py-3 shadow-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle size={20} className="mt-0.5 flex-shrink-0 text-amber-600" />
                <div className="flex-1 text-sm">
                  <p className="font-bold text-amber-900">视频预览可能无法加载</p>
                  <p className="mt-1 text-amber-800">
                    Edge 浏览器对部分视频编码支持不佳。建议使用 Chrome 浏览器以获得最佳体验。
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
        {previewUrl && file ? (
          isGif(file) ? (
            <img src={previewUrl} alt="" className="h-full min-h-52 w-full object-contain" />
          ) : (
            <video
              ref={videoRef}
              src={previewUrl}
              className="h-full min-h-52 w-full object-contain"
              muted={draft.muted}
              playsInline
              preload="metadata"
              controls
              onError={onPlaybackError}
              onCanPlay={onPlaybackReady}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                onPlaybackTimeChange(video.currentTime);
                onMetadataLoaded?.(video.duration);
              }}
              onTimeUpdate={(event) => onPlaybackTimeChange(event.currentTarget.currentTime)}
            />
          )
        ) : (
          <div className="flex h-full min-h-52 flex-col items-center justify-center gap-3 bg-[#e4f7ff] text-center">
            <Upload size={34} className="text-[#6aa9ff]" />
            <div>
              <p className="text-sm font-black text-ink">拖入素材</p>
              <p className="mt-1 text-xs font-bold text-ink/55">MP4 / MOV / GIF</p>
            </div>
          </div>
        )}
        {previewUrl && file && !isGif(file) && playbackFailed && (
          <div className="absolute inset-x-3 bottom-3 rounded-lg border border-ink/20 bg-white/95 p-3 text-xs font-bold leading-5 text-ink shadow-clay-sm">
            浏览器无法预览此视频，云端仍可生成预览图和动态片段。
          </div>
        )}
      </div>
    </section>
  );
}

function MediaPreview({
  file,
  previewUrl,
  draft,
  playbackFailed,
  onPlaybackError,
  onPlaybackReady,
  onPlaybackTimeChange,
  onMetadataLoaded,
}: {
  file: File | null;
  previewUrl: string | null;
  draft: ConversionDraft;
  playbackFailed: boolean;
  onPlaybackError: () => void;
  onPlaybackReady: () => void;
  onPlaybackTimeChange: (seconds: number) => void;
  onMetadataLoaded?: (duration: number) => void;
}) {
  const videoRef = useStartSyncedVideo(draft.startSeconds, onPlaybackTimeChange);

  if (!previewUrl || !file) {
    return (
      <section className="clay-card flex min-h-80 items-center justify-center bg-white text-ink/55">
        <div className="text-center">
          <Film size={34} className="mx-auto text-[#6aa9ff]" />
          <p className="mt-3 text-sm font-black">素材预览</p>
        </div>
      </section>
    );
  }

  return (
    <section className="clay-card relative overflow-hidden bg-ink">
      {isGif(file) ? (
        <img src={previewUrl} alt="" className="h-full max-h-[520px] min-h-80 w-full object-contain" />
      ) : (
        <video
          ref={videoRef}
          src={previewUrl}
          className="h-full max-h-[520px] min-h-80 w-full object-contain"
          controls
          muted={draft.muted}
          playsInline
          preload="metadata"
          onError={onPlaybackError}
          onCanPlay={onPlaybackReady}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            onPlaybackTimeChange(video.currentTime);
            onMetadataLoaded?.(video.duration);
          }}
          onTimeUpdate={(event) => onPlaybackTimeChange(event.currentTarget.currentTime)}
        />
      )}
      {!isGif(file) && playbackFailed && (
        <div className="absolute inset-x-4 bottom-4 rounded-lg border border-ink/20 bg-white/95 p-3 text-sm font-bold leading-6 text-ink shadow-clay-sm">
          浏览器无法播放当前编码，提交云端任务后可查看生成预览图。
        </div>
      )}
    </section>
  );
}

function useStartSyncedVideo(startSeconds: number, onPlaybackTimeChange: (seconds: number) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !Number.isFinite(startSeconds)) {
      return undefined;
    }

    const syncToStart = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      const nextTime = duration === null ? Math.max(0, startSeconds) : clamp(startSeconds, 0, duration);

      if (Math.abs(video.currentTime - nextTime) < 0.05) {
        return;
      }

      video.currentTime = nextTime;
      onPlaybackTimeChange(nextTime);
    };

    if (video.readyState >= 1) {
      syncToStart();
      return undefined;
    }

    video.addEventListener('loadedmetadata', syncToStart, { once: true });

    return () => {
      video.removeEventListener('loadedmetadata', syncToStart);
    };
  }, [onPlaybackTimeChange, startSeconds]);

  return videoRef;
}

function CoverPreview({
  coverUrl,
  isGif,
  open,
  aspectRatioId,
}: {
  coverUrl: string | null;
  isGif: boolean;
  open: () => void;
  aspectRatioId: AspectRatioId;
}) {
  const aspectClass = {
    'source': 'aspect-video',
    '9:16': 'aspect-[9/16]',
    '1:1': 'aspect-square',
    '4:5': 'aspect-[4/5]',
    '16:9': 'aspect-video',
  }[aspectRatioId];

  return (
    <section className="clay-card grid gap-3 bg-white p-4">
      <div>
        <p className="mb-2 text-sm font-black text-ink">关键帧预览</p>
        <div className={`${aspectClass} w-full overflow-hidden rounded-lg border-2 border-ink/15 bg-[#fff4df]`}>
          {coverUrl ? (
            <img src={coverUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full min-h-44 items-center justify-center text-ink/45">
              {isGif ? <Info size={24} /> : <ImageIcon size={24} />}
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={open}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-ink px-4 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5"
      >
        <Upload size={16} />
        更换素材
      </button>
    </section>
  );
}

function SavePathPanel() {
  const items = useMemo(
    () => [
      {
        id: 'android',
        icon: <Smartphone size={20} />,
        title: '安卓实况路径',
        text: '手机直接下载 motion-photo_MP.jpg，优先用 Google Photos 或主流视频平台检查动态照片入口。',
      },
      {
        id: 'desktop',
        icon: <MonitorDown size={20} />,
        title: '桌面复测路径',
        text: '桌面下载 ZIP 后取出安卓实况图，USB 或原文件传输到手机，避免聊天软件压缩。',
      },
    ],
    [],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const activeItem = items[activeIndex] ?? items[0];
  const tickerItemHeightPx = 44;

  useEffect(() => {
    if (isPaused) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % items.length);
    }, 3600);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPaused, items.length]);

  if (!activeItem) {
    return null;
  }

  return (
    <section
      aria-label="下载路径提示"
      tabIndex={0}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      className="group/path relative min-w-0 focus:outline-none"
    >
      <div className="relative h-11 overflow-hidden rounded-lg border-2 border-ink bg-white shadow-clay-sm">
        <div
          aria-live="polite"
          className="will-change-transform transition-transform duration-500 ease-out"
          style={{ transform: `translateY(-${activeIndex * tickerItemHeightPx}px)` }}
        >
          {items.map((item) => (
            <div key={item.id} className="flex h-11 min-w-0 shrink-0 items-center gap-2 px-3 pr-12">
              <span className="shrink-0 text-[#23b7a4]">{item.icon}</span>
              <span className="max-w-28 shrink-0 truncate rounded-md border border-ink/15 bg-[#fff4df] px-2 py-1 text-[11px] font-black text-ink">
                {item.title}
              </span>
              <span className="truncate text-xs font-semibold text-ink/65">{item.text}</span>
            </div>
          ))}
        </div>

        <div className="absolute right-3 top-1/2 flex -translate-y-1/2 gap-1">
          {items.map((item, index) => (
            <span
              key={item.id}
              className={[
                'h-2 w-2 rounded-full border border-ink/20 transition-colors',
                activeIndex === index ? 'bg-[#23b7a4]' : 'bg-ink/20',
              ].join(' ')}
            />
          ))}
        </div>
      </div>

      <div className="pointer-events-none absolute left-0 right-0 top-full z-50 mt-2 hidden rounded-lg border-2 border-ink bg-white p-3 text-xs font-semibold leading-5 text-ink/70 shadow-clay-sm group-hover/path:block group-focus-within/path:block">
        <p className="text-sm font-black text-ink">{activeItem.title}</p>
        <p className="mt-1">{activeItem.text}</p>
      </div>
    </section>
  );
}

function SidebarInfoCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const slides = [
    {
      id: 'phase',
      title: '操作步骤',
      icon: <BadgeCheck size={18} />,
      content: (
        <div className="grid h-full grid-rows-4 gap-2">
          {phaseSteps.map((step, index) => (
            <div
              key={step.label}
              className="flex items-center gap-3 rounded-lg border-2 border-ink/15 bg-white px-3 text-sm font-black text-ink"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink/15 bg-[#e4f7ff] text-xs">
                {index + 1}
              </span>
              <span className="shrink-0 text-[#23b7a4]">{step.icon}</span>
              <span>{step.label}</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'pro',
      title: '导出额度',
      icon: <BadgeCheck size={18} />,
      content: (
        <div className="grid h-full grid-rows-2 gap-2">
          <div className="flex flex-col justify-center rounded-lg border-2 border-ink/15 bg-white p-3">
            <p className="text-sm font-black text-ink">免费版</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-ink/60">每日 5 次本地生成，支持预览片段和完整 ZIP。</p>
          </div>
          <div className="flex flex-col justify-center rounded-lg border-2 border-ink bg-[#d9f99d] p-3 shadow-clay-sm">
            <p className="text-sm font-black text-ink">专业版</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-ink/65">
              云端生成安卓实况单文件，适合真机验证和完整素材交付。
            </p>
          </div>
        </div>
      ),
    },
    {
      id: 'toolbox',
      title: '验证工具',
      icon: <Film size={18} />,
      content: (
        <div className="grid h-full grid-rows-5 gap-1.5">
          <ToolboxMiniItem label="视频/GIF 转安卓实况图" status="available" />
          <ToolboxMiniItem label="查看器兼容记录" status="preview" />
          <ToolboxMiniItem label="安卓实况图转 MP4" status="preview" />
          <ToolboxMiniItem label="图片素材转实况图" status="preview" />
          <ToolboxMiniItem label="云端生成队列" status="planned" />
        </div>
      ),
    },
  ];
  const activeSlide = slides[activeIndex] ?? slides[0];

  useEffect(() => {
    if (isPaused) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % slides.length);
    }, 4600);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPaused, slides.length]);

  if (!activeSlide) {
    return null;
  }

  return (
    <section
      aria-label="产品信息轮播"
      tabIndex={0}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      className="clay-card bg-white p-4 focus:outline-none"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-black text-ink">
          <span className="text-[#ff715b]">{activeSlide.icon}</span>
          {activeSlide.title}
        </div>
        <div className="flex gap-1" aria-label="产品信息切换">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              aria-label={`切换到 ${slide.title}`}
              onClick={() => setActiveIndex(index)}
              className={[
                'h-2.5 rounded-full border border-ink/20 transition-all',
                activeIndex === index ? 'w-5 bg-[#23b7a4]' : 'w-2.5 bg-ink/20 hover:bg-ink/35',
              ].join(' ')}
            />
          ))}
        </div>
      </div>
      <div className="h-44 overflow-hidden rounded-lg">
        <div
          className="flex h-full will-change-transform transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(-${activeIndex * 100}%)` }}
        >
          {slides.map((slide) => (
            <div key={slide.id} className="h-full w-full flex-none">
              {slide.content}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ToolboxMiniItem({ label, status }: { label: string; status: 'available' | 'preview' | 'planned' }) {
  const statusClass = {
    available: 'bg-[#d9f99d]',
    preview: 'bg-[#e4f7ff]',
    planned: 'bg-[#fff4df]',
  }[status];
  const statusLabel = {
    available: '可用',
    preview: '验证中',
    planned: '规划中',
  }[status];

  return (
    <div className="flex h-full items-center justify-between gap-2 rounded-lg border border-ink/15 bg-white px-2 py-1">
      <span className="truncate text-xs font-black text-ink">{label}</span>
      <span className={`shrink-0 rounded-md border border-ink/15 px-2 py-0.5 text-[10px] font-black text-ink/65 ${statusClass}`}>
        {statusLabel}
      </span>
    </div>
  );
}

function ExportResultPanel({
  result,
  packageArtifact,
  onDownload,
  aspectRatioId,
}: {
  result: LocalExportResult;
  packageArtifact: LocalExportArtifact;
  onDownload: (artifact: LocalExportArtifact) => void;
  aspectRatioId: AspectRatioId;
}) {
  const previewArtifact = useMemo(
    () =>
      result.artifacts.find((artifact) => artifact.kind === 'cover') ??
      result.artifacts.find((artifact) => artifact.kind === 'clip') ??
      null,
    [result.artifacts],
  );
  const resultPreviewUrl = useMemo(() => {
    if (!previewArtifact) {
      return null;
    }

    return URL.createObjectURL(previewArtifact.blob);
  }, [previewArtifact]);

  useEffect(() => {
    return () => {
      if (resultPreviewUrl) {
        URL.revokeObjectURL(resultPreviewUrl);
      }
    };
  }, [resultPreviewUrl]);

  return (
    <Panel title="导出结果" icon={<CheckCircle2 size={18} />}>
      <div className="rounded-lg border-2 border-ink bg-[#d9f99d] p-3">
        <p className="text-sm font-black text-ink">{result.presetLabel}</p>
        <p className="mt-1 text-xs font-bold text-ink/65">
          {formatSeconds(result.durationSeconds)} / {new Date(result.createdAt).toLocaleString('zh-CN')}
        </p>
      </div>
      {resultPreviewUrl && previewArtifact && (
        <div
          aria-label="导出结果预览"
          className={`mt-3 overflow-hidden rounded-lg border-2 border-ink bg-ink ${
            {
              'source': 'aspect-video',
              '9:16': 'aspect-[9/16]',
              '1:1': 'aspect-square',
              '4:5': 'aspect-[4/5]',
              '16:9': 'aspect-video',
            }[aspectRatioId]
          }`}
        >
          {previewArtifact.kind === 'cover' ? (
            <img src={resultPreviewUrl} alt="" className="h-full w-full object-contain" />
          ) : (
            <video src={resultPreviewUrl} className="h-full w-full object-contain" muted playsInline controls />
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => onDownload(packageArtifact)}
        className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5"
      >
        <FileArchive size={16} />
        下载完整 ZIP
      </button>
      {result.warnings.length > 0 && (
        <div className="mt-3 rounded-lg border-2 border-ink/15 bg-[#fff4df] p-3">
          <p className="text-xs font-black text-ink">兼容提示</p>
          <ul className="mt-2 grid gap-1 text-xs font-semibold leading-5 text-ink/65">
            {result.warnings.map((warning) => (
              <li key={warning}>- {warning}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 grid gap-2">
        {result.artifacts
          .filter((artifact) => artifact.kind !== 'package')
          .map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              onClick={() => onDownload(artifact)}
              className="rounded-lg border-2 border-ink/15 bg-white p-3 text-left transition hover:border-ink"
            >
              <span className="block text-sm font-black text-ink">{artifact.label}</span>
              <span className="mt-1 block text-xs font-semibold leading-5 text-ink/60">{artifact.description}</span>
            </button>
          ))}
      </div>
    </Panel>
  );
}

function GenerationAccessDialog({
  open,
  access,
  session,
  mode,
  isChecking,
  isConsuming,
  onOpenChange,
  onOpenAuth,
  onUseLocal,
  onConfirm,
}: {
  open: boolean;
  access: GenerationAccessState | null;
  session: AuthSession | null;
  mode: ConversionDraft['mode'];
  isChecking: boolean;
  isConsuming: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAuth: () => void;
  onUseLocal: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isConsuming) {
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isConsuming, onOpenChange, open]);

  if (!open) {
    return null;
  }

  const usage = access?.usage ?? null;
  const isReady = access?.kind === 'ready';
  const isAuthRequired = access?.kind === 'auth-required';
  const isProRequired = access?.kind === 'pro-required';
  const isBlocked = access?.kind === 'quota-exhausted' || access?.kind === 'error';
  const resourceCopy = getGenerationResourceCopy(access?.resource ?? null, mode);
  const planLabel = formatPlanLabel(session);
  const title =
    access?.kind === 'ready'
      ? '导出额度确认'
      : access?.kind === 'pro-required'
        ? '需要专业版导出额度'
        : access?.kind === 'quota-exhausted'
          ? '导出额度已用完'
        : access?.kind === 'error'
            ? '额度校验失败'
            : '登录后生成';

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/45 p-3 sm:items-center sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-access-title"
        className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df] shadow-clay sm:max-h-[calc(100vh-2.5rem)]"
      >
        <div className="flex items-start justify-between gap-3 border-b-2 border-ink bg-white p-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-[#f7c948] text-ink shadow-clay-sm">
              {isChecking ? <Loader2 size={18} className="animate-spin" /> : <Crown size={18} />}
            </span>
            <div className="min-w-0">
              <p id="generation-access-title" className="text-sm font-black text-ink">
                {isChecking ? '正在校验额度' : title}
              </p>
              <p className="mt-1 truncate text-xs font-bold text-ink/55">{session?.user.email ?? '登录后校验导出额度'}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭导出额度确认"
            disabled={isConsuming}
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-white text-ink shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink/35"
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <GenerationResourceCard label="账号版本" value={planLabel} detail={session ? '账号已校验' : '未登录不可导出'} />
            <GenerationResourceCard
              label="导出额度"
              value={formatQuotaValue(usage)}
              detail={formatQuotaDetail(usage)}
            />
          </div>

          <div className="mt-3 rounded-lg border-2 border-ink bg-white p-3">
            <div className="flex items-start gap-3">
              <span
                className={[
                  'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 border-ink shadow-clay-sm',
                  resourceCopy.tone,
                ].join(' ')}
              >
                {resourceCopy.icon}
              </span>
              <div>
                <p className="text-sm font-black text-ink">{resourceCopy.title}</p>
                <p className="mt-1 text-xs font-bold leading-5 text-ink/65">{access?.message ?? resourceCopy.description}</p>
              </div>
            </div>
          </div>

          {isReady && usage && (
            <p className="mt-3 rounded-lg border border-ink/10 bg-[#d9f99d] px-3 py-2 text-xs font-bold leading-5 text-ink/70">
              点击确认后会消耗 1 次今日导出额度，生成完成后可在弹窗里下载结果。
            </p>
          )}

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={isConsuming}
              onClick={() => onOpenChange(false)}
              className="inline-flex h-11 items-center justify-center rounded-lg border-2 border-ink bg-white px-4 text-sm font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink/35"
            >
              取消
            </button>

            {isAuthRequired ? (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onOpenAuth();
                }}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5"
              >
                <LogIn size={16} />
                登录 / 注册
              </button>
            ) : isProRequired ? (
              <button
                type="button"
                onClick={onUseLocal}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#e4f7ff] px-4 text-sm font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5"
              >
                <CloudOff size={16} />
                改用本地生成
              </button>
            ) : (
              <button
                type="button"
                disabled={!isReady || isBlocked || isChecking || isConsuming}
                onClick={onConfirm}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40"
              >
                {isConsuming ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                确认生成
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GenerationResourceCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border-2 border-ink bg-white p-3 shadow-clay-sm">
      <p className="text-xs font-black uppercase text-ink/45">{label}</p>
      <p className="mt-2 text-lg font-black text-ink">{value}</p>
      <p className="mt-1 text-xs font-bold text-ink/55">{detail}</p>
    </div>
  );
}

function getGenerationResourceCopy(resource: GenerationResource | null, mode: ConversionDraft['mode']) {
  if (resource === 'pro-cloud') {
    return {
      title: '专业版云端导出',
      description: '可生成 Android Motion Photo 单文件、预览图和完整素材包，适合最终真机验证。',
      tone: 'bg-[#f7c948]',
      icon: <Crown size={16} />,
    };
  }

  if (resource === 'pro-local') {
    return {
      title: '专业版本地导出',
      description: '使用专业版日额度进行本地导出，素材仍不离开浏览器。',
      tone: 'bg-[#d9f99d]',
      icon: <Crown size={16} />,
    };
  }

  if (resource === 'free-local') {
    return {
      title: '免费版本地导出',
      description: '每日 5 次本地导出，支持标准预设和完整 ZIP 下载。',
      tone: 'bg-[#d9f99d]',
      icon: <ShieldCheck size={16} />,
    };
  }

  if (mode === 'cloud') {
    return {
      title: '云端导出未开放',
      description: '云端安卓实况图需要专业版账号；免费账号可以切回本地生成。',
      tone: 'bg-[#ffe2dc]',
      icon: <Crown size={16} />,
    };
  }

  return {
    title: '等待额度校验',
    description: '登录后会根据账号版本校验可用导出额度。',
    tone: 'bg-[#e4f7ff]',
    icon: <LogIn size={16} />,
  };
}

function AuthEntryButton({
  session,
  onOpen,
  onLogout,
}: {
  session: AuthSession | null;
  onOpen: () => void;
  onLogout: () => void;
}) {
  if (session) {
    const initials = getUserInitials(session.user.username);
    const planLabel = formatPlanLabel(session);
    const createdDateLabel = formatUserCreatedDate(session.user);

    return (
      <div className="relative z-50 inline-flex h-9 rounded-lg text-ink shadow-clay-sm">
        <div className="group/account relative inline-flex h-9 focus-within:z-[70]">
          <div
            tabIndex={0}
            title={session.user.email}
            aria-describedby="auth-account-popover"
            className="inline-flex min-w-0 items-center gap-2 rounded-l-lg border-2 border-r-0 border-ink bg-white px-2 text-xs font-black outline-none transition hover:bg-[#e4f7ff] focus:bg-[#e4f7ff] focus:ring-2 focus:ring-inset focus:ring-[#23b7a4]"
          >
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-ink/15 bg-[#d9f99d] text-[10px]">
              {initials}
            </span>
            <span className="hidden max-w-20 truncate sm:inline">{session.user.username}</span>
            <span
              className={`rounded-md px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${
                session.user.planType === 'pro'
                  ? session.user.dailyQuota < 0
                    ? 'bg-gradient-to-r from-[#f7c948] to-[#ff715b] text-white'
                    : 'bg-[#f7c948] text-ink'
                  : 'bg-[#e4f7ff] text-ink/70'
              }`}
            >
              {formatPlanBadge(session.user)}
            </span>
          </div>

          <div
            id="auth-account-popover"
            className="pointer-events-none absolute right-0 top-full z-[90] mt-2 hidden w-72 max-w-[calc(100vw-1rem)] rounded-lg border-2 border-ink bg-white p-3 text-xs text-ink shadow-clay-sm group-hover/account:block group-focus-within/account:block"
          >
            <div className="flex items-start gap-3 border-b border-ink/10 pb-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-[#d9f99d] text-sm font-black shadow-clay-sm">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-black">
                  <span className="truncate">{session.user.username}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${
                      session.user.planType === 'pro'
                        ? session.user.dailyQuota < 0
                          ? 'bg-gradient-to-r from-[#f7c948] to-[#ff715b] text-white'
                          : 'bg-[#f7c948] text-ink'
                        : 'bg-[#e4f7ff] text-ink/70'
                    }`}
                  >
                    {formatPlanBadge(session.user)}
                  </span>
                </p>
                <p className="mt-1 truncate font-semibold text-ink/60">{session.user.email}</p>
              </div>
            </div>
            <dl className="mt-3 grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <dt className="font-black text-ink/45">账号版本</dt>
                <dd className="min-w-0 truncate font-black">{planLabel}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="font-black text-ink/45">本地生成</dt>
                <dd className="min-w-0 truncate font-black">
                  {session.user.localQuotaDaily < 0 ? '无限' : `${session.user.localQuotaDaily} 次/日`}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="font-black text-ink/45">云端生成</dt>
                <dd className="min-w-0 truncate font-black">
                  {session.user.cloudQuotaDaily < 0 ? '无限' : `${session.user.cloudQuotaDaily} 次/日`}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="font-black text-ink/45">注册时间</dt>
                <dd className="min-w-0 truncate font-black">{createdDateLabel}</dd>
              </div>
            </dl>
          </div>
        </div>
        <button
          type="button"
          aria-label="退出登录"
          onClick={onLogout}
          className="inline-flex w-8 items-center justify-center rounded-r-lg border-2 border-ink bg-white text-ink/70 transition hover:bg-[#ffe2dc] hover:text-ink"
        >
          <LogOut size={14} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-ink px-2.5 text-xs font-black text-white shadow-clay-sm transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-[#23b7a4]"
    >
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[#d9f99d] text-ink">
        <UserRound size={14} />
      </span>
      <span>登录</span>
      <span className="rounded-md border border-white/15 bg-white/10 px-1.5 py-0.5 text-[10px] text-white/75">
        注册
      </span>
    </button>
  );
}

function LogoutConfirmDialog({
  open,
  user,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  user: AuthUser | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onOpenChange, open]);

  if (!open || !user) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/45 p-3 sm:items-center sm:p-5">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-confirm-title"
        aria-describedby="logout-confirm-description"
        className="w-full max-w-sm overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df] shadow-clay"
      >
        <div className="flex items-start justify-between gap-3 border-b-2 border-ink bg-white p-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-[#ffe2dc] text-[#ff715b] shadow-clay-sm">
              <LogOut size={18} />
            </span>
            <div className="min-w-0">
              <p id="logout-confirm-title" className="text-sm font-black text-ink">
                确认退出登录？
              </p>
              <p className="mt-1 truncate text-xs font-bold text-ink/55">{user.email}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭退出确认"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-white text-ink shadow-clay-sm transition hover:-translate-y-0.5"
          >
            <X size={17} />
          </button>
        </div>

        <div className="p-4">
          <p id="logout-confirm-description" className="text-xs font-bold leading-5 text-ink/65">
            退出后会清除本机保存的账号状态，当前素材和页面设置不会被删除。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-11 items-center justify-center rounded-lg border-2 border-ink bg-white px-4 text-sm font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#ff715b] px-4 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-[#23b7a4]"
            >
              <LogOut size={16} />
              退出登录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface AuthFieldErrors {
  email?: string;
  username?: string;
  password?: string;
  emailCode?: string;
}

interface PasswordRuleState {
  label: string;
  passed: boolean;
}

interface AuthChallenge {
  id: string;
  nonce: string;
  algorithm: 'sha256-prefix-v1';
  difficulty: number;
  prefix: string;
  expiresAt: string;
}

interface AuthLoginEmailTicket {
  ticket: string;
  email: string;
  expiresAt: string;
}

interface AuthEmailCodeResponse {
  ok?: boolean;
  cooldownSeconds?: number;
  message?: string;
}

interface AuthLoginEmailCodeRequiredResponse {
  requiresEmailCode: true;
  loginTicket: string;
  email: string;
  expiresAt: string;
  message?: string;
}

interface AuthFormValues {
  email: string;
  username: string;
  password: string;
  emailCode: string;
  automationTrap: string;
}

function readAuthFormValues(form: HTMLFormElement): AuthFormValues {
  const formData = new FormData(form);
  const getValue = (name: string) => String(formData.get(name) ?? '');

  return {
    email: getValue('email'),
    username: getValue('display-name'),
    password: getValue('current-password') || getValue('new-password') || getValue('password'),
    emailCode: getValue('one-time-code').replace(/\D/gu, '').slice(0, 6),
    automationTrap: getValue('company-url'),
  };
}

function validateAuthForm(mode: AuthMode, email: string, username: string, password: string, emailCode: string, requireEmailCode: boolean): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim();

  if (!isValidAuthEmail(normalizedEmail)) {
    errors.email = '请输入有效邮箱。';
  }

  if (mode === 'register' && !/^[\p{L}\p{N}_-]{2,32}$/u.test(normalizedUsername)) {
    errors.username = '用户名需为 2-32 位，可用中英文、数字、下划线或短横线。';
  }

  if (mode === 'login' && !requireEmailCode) {
    if (!password) {
      errors.password = '请输入密码。';
    }
  } else if (mode !== 'login') {
    const passwordUsername = mode === 'register' ? normalizedUsername : '';
    const failedRule = getPasswordRules(password, normalizedEmail, passwordUsername).find((rule) => !rule.passed);

    if (failedRule) {
      errors.password = failedRule.label;
    }
  }

  if (requireEmailCode && !/^\d{6}$/u.test(emailCode.trim())) {
    errors.emailCode = '请输入 6 位邮箱验证码。';
  }

  return errors;
}

function validateAuthLoginEmailStep(email: string): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  const normalizedEmail = email.trim().toLowerCase();

  if (!isValidAuthEmail(normalizedEmail)) {
    errors.email = '请输入有效邮箱。';
  }

  return errors;
}

function validateAuthEmailCodeRequest(mode: AuthMode, email: string, username: string): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim();

  if (!isValidAuthEmail(normalizedEmail)) {
    errors.email = '请输入有效邮箱。';
  }

  if (mode === 'register') {
    if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(normalizedUsername)) {
      errors.username = '用户名需为 2-32 位，可用中英文、数字、下划线或短横线。';
    }
  }

  return errors;
}

function getPasswordRules(password: string, email: string, username: string): PasswordRuleState[] {
  const categoryCount = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  const emailName = email.split('@')[0] ?? '';
  const normalizedPassword = password.toLowerCase();

  return [
    { label: '10-128 位', passed: password.length >= 10 && password.length <= 128 },
    { label: '至少包含 3 类字符', passed: categoryCount >= 3 },
    {
      label: '不包含邮箱或用户名',
      passed:
        (!emailName || emailName.length < 3 || !normalizedPassword.includes(emailName)) &&
        (!username || username.length < 3 || !normalizedPassword.includes(username.toLowerCase())),
    },
  ];
}

function isValidAuthEmail(value: string): boolean {
  if (value.length > 254) {
    return false;
  }

  const parts = value.split('@');

  if (parts.length !== 2) {
    return false;
  }

  const localPart = parts[0];
  const domain = parts[1];

  if (
    !localPart ||
    !domain ||
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(localPart)
  ) {
    return false;
  }

  return isValidAuthEmailDomain(domain);
}

function isValidAuthEmailDomain(domain: string): boolean {
  if (domain.length > 253 || domain.includes('..')) {
    return false;
  }

  const labels = domain.split('.');

  if (labels.length < 2) {
    return false;
  }

  return labels.every((label, index) => {
    const isTopLevelDomain = index === labels.length - 1;

    return (
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label) &&
      (!isTopLevelDomain || /^[a-z]{2,63}$/i.test(label))
    );
  });
}

async function createLoginChallengeProof(): Promise<{ challengeId: string; challengeAnswer: string }> {
  const response = await fetch(toApiUrl('/api/v1/auth/challenge'), {
    cache: 'no-store',
    credentials: 'include',
  });
  const challenge = (await response.json().catch(() => null)) as AuthChallenge | null;

  if (!response.ok || !challenge || challenge.algorithm !== 'sha256-prefix-v1') {
    throw new Error('auth-challenge-failed');
  }

  for (let answer = 0; answer <= 10_000_000; answer += 1) {
    const digest = await hashLoginChallenge(challenge.id, challenge.nonce, answer.toString());

    if (digest.startsWith(challenge.prefix)) {
      return {
        challengeId: challenge.id,
        challengeAnswer: answer.toString(),
      };
    }
  }

  throw new Error('auth-challenge-timeout');
}

async function hashLoginChallenge(challengeId: string, nonce: string, answer: string): Promise<string> {
  const data = new TextEncoder().encode(`${challengeId}:${nonce}:${answer}`);

  if (globalThis.crypto?.subtle) {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', data);

      return bytesToHex(new Uint8Array(digest));
    } catch {
      return sha256Hex(data);
    }
  }

  return sha256Hex(data);
}

const sha256RoundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256Hex(input: Uint8Array): string {
  const bitLengthHigh = Math.floor((input.length * 8) / 0x100000000);
  const bitLengthLow = (input.length * 8) >>> 0;
  const paddedLength = (((input.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  const words = new Array<number>(64).fill(0);
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  padded.set(input);
  padded[input.length] = 0x80;
  padded[paddedLength - 8] = bitLengthHigh >>> 24;
  padded[paddedLength - 7] = bitLengthHigh >>> 16;
  padded[paddedLength - 6] = bitLengthHigh >>> 8;
  padded[paddedLength - 5] = bitLengthHigh;
  padded[paddedLength - 4] = bitLengthLow >>> 24;
  padded[paddedLength - 3] = bitLengthLow >>> 16;
  padded[paddedLength - 2] = bitLengthLow >>> 8;
  padded[paddedLength - 1] = bitLengthLow;

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] =
        ((readByte(padded, wordOffset) << 24) |
          (readByte(padded, wordOffset + 1) << 16) |
          (readByte(padded, wordOffset + 2) << 8) |
          readByte(padded, wordOffset + 3)) >>>
        0;
    }

    for (let index = 16; index < 64; index += 1) {
      const word15 = readWord(words, index - 15);
      const word2 = readWord(words, index - 2);
      const s0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const s1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (readWord(words, index - 16) + s0 + readWord(words, index - 7) + s1) >>> 0;
    }

    let a = readWord(hash, 0);
    let b = readWord(hash, 1);
    let c = readWord(hash, 2);
    let d = readWord(hash, 3);
    let e = readWord(hash, 4);
    let f = readWord(hash, 5);
    let g = readWord(hash, 6);
    let h = readWord(hash, 7);

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + readWord(sha256RoundConstants, index) + readWord(words, index)) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (readWord(hash, 0) + a) >>> 0;
    hash[1] = (readWord(hash, 1) + b) >>> 0;
    hash[2] = (readWord(hash, 2) + c) >>> 0;
    hash[3] = (readWord(hash, 3) + d) >>> 0;
    hash[4] = (readWord(hash, 4) + e) >>> 0;
    hash[5] = (readWord(hash, 5) + f) >>> 0;
    hash[6] = (readWord(hash, 6) + g) >>> 0;
    hash[7] = (readWord(hash, 7) + h) >>> 0;
  }

  return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
}

function readByte(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function readWord(words: ArrayLike<number>, index: number): number {
  return words[index] ?? 0;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function AuthDialog({
  open,
  onOpenChange,
  onAuthSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthSuccess: (session: AuthSession) => void;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const [loginEmailTicket, setLoginEmailTicket] = useState<AuthLoginEmailTicket | null>(null);
  const [loginStep, setLoginStep] = useState<AuthLoginStep>('email');
  const [rememberLogin, setRememberLogin] = useState(false);
  const [automationTrap, setAutomationTrap] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingEmailCode, setIsSendingEmailCode] = useState(false);
  const [emailCodeCooldown, setEmailCodeCooldown] = useState(0);
  const authFormRef = useRef<HTMLFormElement | null>(null);
  const requiresEmailCode = mode !== 'login' || Boolean(loginEmailTicket);
  const isLoginEmailStep = mode === 'login' && !loginEmailTicket && loginStep === 'email';
  const isLoginPasswordStep = mode === 'login' && !loginEmailTicket && loginStep === 'password';
  const shouldShowPasswordField = !loginEmailTicket && (mode !== 'login' || isLoginPasswordStep);
  const fieldErrors = useMemo(
    () => (isLoginEmailStep ? validateAuthLoginEmailStep(email) : validateAuthForm(mode, email, username, password, emailCode, requiresEmailCode)),
    [email, emailCode, isLoginEmailStep, mode, password, requiresEmailCode, username],
  );
  const passwordRules = useMemo(
    () => getPasswordRules(password, email.trim().toLowerCase(), mode === 'register' ? username.trim() : ''),
    [email, mode, password, username],
  );
  const isEmailCodeComplete = /^\d{6}$/u.test(emailCode.trim());
  const authModeItems: AuthMode[] = ['login', 'register', 'reset-password'];
  const authFormKind = loginEmailTicket ? 'login-code' : mode === 'login' ? `login-${loginStep}` : mode;
  const authFormId = `vidlive-auth-${authFormKind}`;
  const displayNameFieldId = 'display-name';
  const passwordFieldId = mode === 'login' ? 'current-password' : 'new-password';
  const passwordFieldName = mode === 'login' ? 'current-password' : 'new-password';
  const passwordAutocomplete = mode === 'login' ? 'current-password' : 'new-password';
  const emailFieldId = 'email';
  const emailCodeFieldId = 'one-time-code';
  const submitLabel = loginEmailTicket
    ? '验证并登录'
    : mode === 'login'
      ? isLoginEmailStep
        ? '下一步'
        : '进入账号'
      : mode === 'register'
        ? '创建账号'
        : '重置密码';
  const resetAuthTransientState = useCallback((clearPassword = false) => {
    setEmailCode('');
    setLoginEmailTicket(null);
    setEmailCodeCooldown(0);
    setStatus(null);
    setIsSubmitting(false);
    setIsSendingEmailCode(false);

    if (clearPassword) {
      setLoginStep('email');
      setPassword('');
      setIsPasswordVisible(false);
    }
  }, []);
  const closeAuthDialog = useCallback(() => {
    resetAuthTransientState(true);
    setAutomationTrap('');
    onOpenChange(false);
  }, [onOpenChange, resetAuthTransientState]);
  const syncAuthFormValuesFromDom = useCallback(() => {
    const form = authFormRef.current;

    if (!form) {
      return;
    }

    const values = readAuthFormValues(form);

    if (values.email) {
      setEmail((current) => (current === values.email ? current : values.email));
    }

    if (mode === 'register' && values.username) {
      setUsername((current) => (current === values.username ? current : values.username));
    }

    if (!loginEmailTicket && values.password) {
      setPassword((current) => (current === values.password ? current : values.password));
    }

    if (values.emailCode) {
      setEmailCode((current) => (current === values.emailCode ? current : values.emailCode));
    }

    if (values.automationTrap) {
      setAutomationTrap((current) => (current === values.automationTrap ? current : values.automationTrap));
    }
  }, [loginEmailTicket, mode]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAuthDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeAuthDialog, open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const firstTimerId = window.setTimeout(syncAuthFormValuesFromDom, 120);
    const secondTimerId = window.setTimeout(syncAuthFormValuesFromDom, 600);

    return () => {
      window.clearTimeout(firstTimerId);
      window.clearTimeout(secondTimerId);
    };
  }, [authFormId, open, syncAuthFormValuesFromDom]);

  useEffect(() => {
    if (emailCodeCooldown <= 0) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      setEmailCodeCooldown((current) => Math.max(0, current - 1));
    }, 1000);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [emailCodeCooldown]);

  if (!open) {
    return null;
  }

  const switchAuthMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    resetAuthTransientState(true);
    setAutomationTrap('');
  };

  const returnToLoginEmailStep = () => {
    setLoginStep('email');
    resetAuthTransientState(true);
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    setEmailCode('');
    setLoginEmailTicket(null);
  };

  const handlePasswordChange = (value: string) => {
    setPassword(value);
    setLoginEmailTicket(null);
  };

  const requestEmailCode = async () => {
    if (mode === 'login') {
      return;
    }

    const formValues = authFormRef.current
      ? readAuthFormValues(authFormRef.current)
      : { email, username, password, emailCode, automationTrap };
    const submittedEmail = formValues.email;
    const submittedUsername = formValues.username;
    const nextErrors = validateAuthEmailCodeRequest(mode, submittedEmail, submittedUsername);

    setEmail(submittedEmail);
    setUsername(submittedUsername);
    setPassword(formValues.password);
    setAutomationTrap(formValues.automationTrap);

    if (Object.keys(nextErrors).length > 0) {
      setStatus(Object.values(nextErrors)[0] ?? '请检查表单。');
      return;
    }

    setIsSendingEmailCode(true);
    setStatus(null);

    try {
      const normalizedEmail = submittedEmail.trim().toLowerCase();
      const requestBody: {
        email: string;
        purpose: 'register' | 'reset-password';
        username?: string;
      } = {
        email: normalizedEmail,
        purpose: mode === 'register' ? 'register' : 'reset-password',
      };

      if (mode === 'register') {
        requestBody.username = submittedUsername.trim();
      }

      const response = await fetch(toApiUrl('/api/v1/auth/email-codes'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json().catch(() => null)) as AuthEmailCodeResponse | null;

      if (!response.ok) {
        setStatus(payload?.message ?? '验证码发送失败');
        return;
      }

      setEmail(normalizedEmail);
      setEmailCode('');
      setEmailCodeCooldown(payload?.cooldownSeconds ?? 60);
      setStatus(payload?.message ?? '验证码已发送，请查看邮箱。');
    } catch {
      setStatus('验证码服务不可用');
    } finally {
      setIsSendingEmailCode(false);
    }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formValues = readAuthFormValues(event.currentTarget);
    const submittedEmail = formValues.email;
    const submittedUsername = formValues.username;
    const submittedPassword = loginEmailTicket ? '' : formValues.password;
    const submittedEmailCode = formValues.emailCode;
    const submittedAutomationTrap = formValues.automationTrap;

    setEmail(submittedEmail);
    setUsername(submittedUsername);
    setPassword(submittedPassword);
    setEmailCode(submittedEmailCode);
    setAutomationTrap(submittedAutomationTrap);

    if (isLoginEmailStep) {
      const nextErrors = validateAuthLoginEmailStep(submittedEmail);

      if (Object.keys(nextErrors).length > 0) {
        setStatus(Object.values(nextErrors)[0] ?? '请检查表单。');
        return;
      }

      setEmail(submittedEmail.trim().toLowerCase());
      setPassword('');
      setIsPasswordVisible(false);
      setStatus(null);
      setLoginStep('password');
      return;
    }

    const nextErrors = validateAuthForm(mode, submittedEmail, submittedUsername, submittedPassword, submittedEmailCode, requiresEmailCode);

    if (Object.keys(nextErrors).length > 0) {
      setStatus(Object.values(nextErrors)[0] ?? '请检查表单。');
      return;
    }

    setIsSubmitting(true);
    setStatus(null);

    try {
      const normalizedEmail = submittedEmail.trim().toLowerCase();
      const trimmedEmailCode = submittedEmailCode.trim();

      if (loginEmailTicket) {
        const response = await fetch(toApiUrl('/api/v1/auth/login/email-code'), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            loginTicket: loginEmailTicket.ticket,
            emailCode: trimmedEmailCode,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { user?: AuthUser; token?: string; message?: string }
          | null;

        if (!response.ok || !payload?.user || !payload.token) {
          setStatus(payload?.message ?? '邮箱验证码校验失败');
          return;
        }

        resetAuthTransientState(true);
        onAuthSuccess({
          user: payload.user,
          token: payload.token,
        });
        return;
      }

      if (mode === 'reset-password') {
        const response = await fetch(toApiUrl('/api/v1/auth/reset-password'), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: normalizedEmail,
            password: submittedPassword,
            emailCode: trimmedEmailCode,
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;

        if (!response.ok || !payload?.ok) {
          setStatus(payload?.message ?? '密码重置失败');
          return;
        }

        setMode('login');
        setLoginStep('email');
        setPassword('');
        setIsPasswordVisible(false);
        setEmailCode('');
        setLoginEmailTicket(null);
        setStatus(payload.message ?? '密码已重置，请使用新密码登录。');
        return;
      }

      const challengeProof = mode === 'login' ? await createLoginChallengeProof() : null;
      const authRequestBody: {
        email: string;
        password: string;
        username?: string;
        emailCode?: string;
        remember?: boolean;
        challengeId?: string;
        challengeAnswer?: string;
        automationTrap?: string;
      } = {
        email: normalizedEmail,
        password: submittedPassword,
      };

      if (mode === 'register') {
        authRequestBody.username = submittedUsername.trim();
        authRequestBody.emailCode = trimmedEmailCode;
      }

      if (mode === 'login') {
        authRequestBody.remember = rememberLogin;
      }

      if (challengeProof) {
        authRequestBody.challengeId = challengeProof.challengeId;
        authRequestBody.challengeAnswer = challengeProof.challengeAnswer;
      }

      if (submittedAutomationTrap) {
        authRequestBody.automationTrap = submittedAutomationTrap;
      }

      const response = await fetch(toApiUrl(mode === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(authRequestBody),
      });
      const payload = (await response.json().catch(() => null)) as
        | ({ user?: AuthUser; token?: string; message?: string } & Partial<AuthLoginEmailCodeRequiredResponse>)
        | null;

      if (
        response.status === 202 &&
        payload?.requiresEmailCode === true &&
        payload.loginTicket &&
        payload.email &&
        payload.expiresAt
      ) {
        setEmail(payload.email);
        setPassword('');
        setIsPasswordVisible(false);
        setEmailCode('');
        setLoginEmailTicket({
          ticket: payload.loginTicket,
          email: payload.email,
          expiresAt: payload.expiresAt,
        });
        setStatus(payload.message ?? '检测到新的登录环境，请输入邮箱验证码。');
        return;
      }

      if (!response.ok || !payload?.user) {
        setStatus(payload?.message ?? '账号请求失败');
        return;
      }

      if (mode === 'register') {
        setMode('login');
        setLoginStep('email');
        setEmail(payload.user.email || normalizedEmail);
        setUsername('');
        setPassword('');
        setIsPasswordVisible(false);
        setEmailCode('');
        setAutomationTrap('');
        setStatus('注册成功，请登录。');
        return;
      }

      if (!payload.token) {
        setStatus('账号请求失败');
        return;
      }

      resetAuthTransientState(true);
      onAuthSuccess({
        user: payload.user,
        token: payload.token,
      });
    } catch (error) {
      setStatus(error instanceof Error && error.message === 'auth-challenge-unsupported' ? '当前浏览器不支持登录校验。' : '账号服务不可用');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-ink/45 p-3 sm:items-center sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-dialog-title"
        className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-md flex-col overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df] shadow-clay sm:max-h-[calc(100vh-2.5rem)]"
      >
        <div className="flex items-start justify-between gap-3 border-b-2 border-ink bg-white p-4">
          <div>
            <p id="auth-dialog-title" className="flex items-center gap-2 text-sm font-black text-ink">
              <LogIn size={18} className="text-[#23b7a4]" />
              VidLive 账号
            </p>
            <p className="mt-1 text-xs font-bold leading-5 text-ink/60">用于同步安卓实况图导出额度。</p>
          </div>
          <button
            type="button"
            aria-label="关闭 VidLive 账号"
            onClick={closeAuthDialog}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-white text-ink shadow-clay-sm transition hover:-translate-y-0.5"
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="mb-4 grid grid-cols-3 gap-2 rounded-lg border-2 border-ink bg-white p-1">
            {authModeItems.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => switchAuthMode(item)}
                className={[
                  'h-9 rounded-md text-xs font-black transition',
                  mode === item ? 'bg-ink text-white' : 'bg-transparent text-ink/60 hover:bg-[#e4f7ff] hover:text-ink',
                ].join(' ')}
              >
                {item === 'login' ? '登录' : item === 'register' ? '注册' : '重置'}
              </button>
            ))}
          </div>

          <form ref={authFormRef} key={authFormId} id={authFormId} onSubmit={submitAuth} autoComplete="on" className="grid gap-3">
            {mode === 'register' && (
              <AuthTextField
                id={displayNameFieldId}
                name="display-name"
                label="用户名"
                value={username}
                type="text"
                autoComplete="nickname"
                placeholder="VidLive 用户"
                error={fieldErrors.username}
                maxLength={32}
                onChange={setUsername}
              />
            )}
            {isLoginPasswordStep ? (
              <div className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-2">
                <button
                  type="button"
                  aria-label="返回邮箱输入"
                  onClick={returnToLoginEmailStep}
                  className="mt-5 inline-flex h-11 w-11 items-center justify-center rounded-lg border-2 border-ink bg-white text-ink shadow-clay-sm transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-[#23b7a4]"
                >
                  <ArrowLeft size={17} />
                </button>
                <AuthTextField
                  id={emailFieldId}
                  name="email"
                  label="邮箱"
                  value={email}
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  placeholder="you@example.com"
                  error={fieldErrors.email}
                  maxLength={254}
                  readOnly
                  onChange={handleEmailChange}
                />
              </div>
            ) : (
              <AuthTextField
                id={emailFieldId}
                name="email"
                label="邮箱"
                value={email}
                type="email"
                autoComplete="username"
                inputMode="email"
                placeholder="you@example.com"
                error={fieldErrors.email}
                maxLength={254}
                onChange={handleEmailChange}
              />
            )}
            {shouldShowPasswordField && (
              <AuthPasswordField
                id={passwordFieldId}
                name={passwordFieldName}
                label={mode === 'reset-password' ? '新密码' : '密码'}
                value={password}
                autoComplete={passwordAutocomplete}
                visible={isPasswordVisible}
                placeholder={mode === 'login' ? '输入密码' : '10 位以上，含多类字符'}
                error={fieldErrors.password}
                maxLength={128}
                onChange={handlePasswordChange}
                onVisibleChange={setIsPasswordVisible}
              />
            )}
            <div aria-hidden="true" className="hidden">
              <label>
                公司网址
                <input
                  type="text"
                  name="company-url"
                  tabIndex={-1}
                  autoComplete="off"
                  value={automationTrap}
                  onChange={(event) => setAutomationTrap(event.target.value)}
                />
              </label>
            </div>

            {(mode === 'register' || mode === 'reset-password') && (
              <div className="grid gap-1 rounded-lg border-2 border-ink/10 bg-white/70 p-3">
                {passwordRules.map((rule) => (
                  <p
                    key={rule.label}
                    className={['flex items-center gap-2 text-[11px] font-black', rule.passed ? 'text-[#167f72]' : 'text-ink/45'].join(' ')}
                  >
                    <CheckCircle2 size={13} />
                    {rule.label}
                  </p>
                ))}
              </div>
            )}

            {requiresEmailCode && (
              <div className="grid gap-1">
                <label className="grid gap-1 text-xs font-black text-ink/60">
                  邮箱验证码
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-2">
                    <input
                      id={emailCodeFieldId}
                      name="one-time-code"
                      type="text"
                      value={emailCode}
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="6 位数字"
                      maxLength={6}
                      aria-invalid={Boolean(fieldErrors.emailCode)}
                      onInput={(event) => setEmailCode(event.currentTarget.value.replace(/\D/gu, '').slice(0, 6))}
                      onChange={(event) => setEmailCode(event.currentTarget.value.replace(/\D/gu, '').slice(0, 6))}
                      className={[
                        'h-11 rounded-lg border-2 bg-white px-3 text-sm font-black text-ink placeholder:text-ink/30 focus:outline-none focus:ring-2',
                        fieldErrors.emailCode
                          ? 'border-[#ff715b] focus:border-[#ff715b] focus:ring-[#ff715b]/30'
                          : 'border-ink/15 focus:border-ink focus:ring-[#23b7a4]',
                      ].join(' ')}
                    />
                    {(mode === 'register' || mode === 'reset-password') && (
                      <button
                        type="button"
                        disabled={isSendingEmailCode || emailCodeCooldown > 0}
                        onClick={requestEmailCode}
                        className={[
                          'inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border-2 border-ink px-2 text-xs font-black shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed',
                          isEmailCodeComplete
                            ? 'bg-[#23b7a4] text-white disabled:bg-[#23b7a4] disabled:text-white'
                            : 'bg-white text-ink disabled:bg-ink/10 disabled:text-ink/40',
                        ].join(' ')}
                      >
                        {isSendingEmailCode ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                        <span className="whitespace-nowrap">{emailCodeCooldown > 0 ? `${emailCodeCooldown}s` : '发送验证码'}</span>
                      </button>
                    )}
                  </div>
                  {fieldErrors.emailCode && <span className="text-[11px] leading-4 text-[#b63f2f]">{fieldErrors.emailCode}</span>}
                </label>
                {loginEmailTicket && (
                  <p className="text-[11px] font-bold leading-4 text-ink/55">
                    验证码已发送至 {loginEmailTicket.email}，请在邮箱中查看。
                  </p>
                )}
              </div>
            )}

            {isLoginPasswordStep && (
              <label className="inline-flex items-center gap-2 text-xs font-black text-ink/65">
                <input
                  type="checkbox"
                  checked={rememberLogin}
                  onChange={(event) => setRememberLogin(event.target.checked)}
                  className="h-4 w-4 accent-[#23b7a4]"
                />
                保持登录 3 天
              </label>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40"
            >
              {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <UserRound size={16} />}
              {submitLabel}
            </button>

            {status && <p className="text-xs font-bold leading-5 text-ink/60">{status}</p>}
          </form>
        </div>
      </div>
    </div>
  );
}

function AuthTextField({
  id,
  name,
  label,
  value,
  type,
  autoComplete,
  inputMode,
  placeholder,
  error,
  maxLength,
  readOnly = false,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  type: 'email' | 'password' | 'text';
  value: string;
  autoComplete: string;
  inputMode?: 'email' | 'numeric' | 'text';
  placeholder: string;
  error?: string | undefined;
  maxLength?: number;
  readOnly?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-black text-ink/60">
      {label}
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        placeholder={placeholder}
        maxLength={maxLength}
        readOnly={readOnly}
        aria-invalid={Boolean(error)}
        onInput={(event) => {
          if (!readOnly) {
            onChange(event.currentTarget.value);
          }
        }}
        onChange={(event) => {
          if (!readOnly) {
            onChange(event.currentTarget.value);
          }
        }}
        className={[
          'h-11 rounded-lg border-2 bg-white px-3 text-sm font-black text-ink placeholder:text-ink/30 focus:outline-none focus:ring-2',
          error ? 'border-[#ff715b] focus:border-[#ff715b] focus:ring-[#ff715b]/30' : 'border-ink/15 focus:border-ink focus:ring-[#23b7a4]',
        ].join(' ')}
      />
      {error && <span className="text-[11px] leading-4 text-[#b63f2f]">{error}</span>}
    </label>
  );
}

function AuthPasswordField({
  id,
  name,
  label,
  value,
  autoComplete,
  visible,
  placeholder,
  error,
  maxLength,
  onChange,
  onVisibleChange,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  autoComplete: string;
  visible: boolean;
  placeholder: string;
  error?: string | undefined;
  maxLength?: number;
  onChange: (value: string) => void;
  onVisibleChange: (visible: boolean) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-black text-ink/60">
      {label}
      <span className="relative block">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-invalid={Boolean(error)}
          onInput={(event) => onChange(event.currentTarget.value)}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={[
            'h-11 w-full rounded-lg border-2 bg-white px-3 pr-11 text-sm font-black text-ink placeholder:text-ink/30 focus:outline-none focus:ring-2',
            error ? 'border-[#ff715b] focus:border-[#ff715b] focus:ring-[#ff715b]/30' : 'border-ink/15 focus:border-ink focus:ring-[#23b7a4]',
          ].join(' ')}
        />
        <button
          type="button"
          aria-label={visible ? '隐藏密码' : '显示密码'}
          aria-pressed={visible}
          onClick={() => onVisibleChange(!visible)}
          className="absolute right-1.5 top-1.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/55 transition hover:bg-[#e4f7ff] hover:text-ink focus:outline-none focus:ring-2 focus:ring-[#23b7a4]"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
      {error && <span className="text-[11px] leading-4 text-[#b63f2f]">{error}</span>}
    </label>
  );
}

function getUserInitials(username: string): string {
  const trimmed = username.trim();

  if (!trimmed) {
    return 'U';
  }

  return trimmed.slice(0, 2).toUpperCase();
}

function GenerationStatusButton({
  status,
  progress,
  onClick,
}: {
  status: GenerationStatus;
  progress: number;
  onClick: () => void;
}) {
  const safeProgress = clamp(progress, 0, 100);
  const copy = {
    generating: {
      label: '生成中',
      detail: `${safeProgress}%`,
      className: 'bg-[#e4f7ff] text-ink',
      icon: <Loader2 size={15} className="animate-spin text-[#6aa9ff]" />,
    },
    complete: {
      label: '已生成',
      detail: '查看下载',
      className: 'bg-[#d9f99d] text-ink',
      icon: <CheckCircle2 size={15} className="text-[#23b7a4]" />,
    },
    failed: {
      label: '生成失败',
      detail: '查看原因',
      className: 'bg-[#ffe2dc] text-ink',
      icon: <AlertTriangle size={15} className="text-[#ff715b]" />,
    },
  }[status];

  return (
    <button
      type="button"
      aria-live="polite"
      onClick={onClick}
      className={`fixed bottom-20 left-4 z-40 inline-flex h-11 max-w-[calc(100vw-2rem)] items-center justify-center gap-2 rounded-lg border-2 border-ink px-3 text-xs font-black shadow-clay transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-[#23b7a4] lg:bottom-4 ${copy.className}`}
    >
      {copy.icon}
      <span>{copy.label}</span>
      <span className="rounded-md border border-ink/15 bg-white/80 px-2 py-0.5 text-[10px] text-ink/65">
        {copy.detail}
      </span>
    </button>
  );
}

function GenerationDialog({
  open,
  status,
  mode,
  progress,
  failure,
  cloudJob,
  downloadUrl,
  androidMotionPhotoUrl,
  previewPhotoUrl,
  exportResult,
  packageArtifact,
  downloadingSource,
  onOpenChange,
  onCloudDownload,
  onLocalDownload,
  onDeleteCloudJob,
  aspectRatioId,
}: {
  open: boolean;
  status: GenerationStatus;
  mode: ConversionDraft['mode'];
  progress: number;
  failure: { title: string; action: string } | null;
  cloudJob: CloudJob | null;
  downloadUrl: string | null;
  androidMotionPhotoUrl: string | null;
  previewPhotoUrl: string | null;
  exportResult: LocalExportResult | null;
  packageArtifact: LocalExportArtifact | null;
  downloadingSource: CloudDownloadRequest['source'] | null;
  onOpenChange: (open: boolean) => void;
  onCloudDownload: (download: CloudDownloadRequest) => void;
  onLocalDownload: (artifact: LocalExportArtifact) => void;
  onDeleteCloudJob: () => Promise<void>;
  aspectRatioId: AspectRatioId;
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onOpenChange, open]);

  if (!open) {
    return null;
  }

  const isCloudMode = mode === 'cloud' || Boolean(cloudJob);
  const safeProgress = clamp(progress, 0, 100);
  const title =
    status === 'generating'
      ? isCloudMode
        ? '正在生成安卓实况图'
        : '正在生成导出包'
      : status === 'failed'
        ? '生成失败'
        : '生成完成';
  const description =
    status === 'generating'
      ? '进度和后续结果都会留在这里，关闭弹窗后也能从左下角重新打开。'
      : status === 'failed'
        ? '这次没有拿到可用导出结果，先看原因再调整素材。'
        : '导出结果已经生成，直接在这里预览和下载。';
  const titleIcon =
    status === 'generating' ? (
      <Loader2 size={18} className="animate-spin text-[#6aa9ff]" />
    ) : status === 'failed' ? (
      <AlertTriangle size={18} className="text-[#ff715b]" />
    ) : (
      <CheckCircle2 size={18} className="text-[#23b7a4]" />
    );
  const progressLabel =
    status === 'failed'
      ? '生成中断'
      : status === 'complete'
        ? '' // 完成时不显示文字，只显示百分比
        : isCloudMode
          ? cloudJob
            ? '云端处理返回进度'
            : '上传并创建任务'
          : safeProgress < 15
            ? '准备素材'
            : safeProgress < 90
              ? '本地渲染与打包'
              : '整理下载文件';

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/45 p-3 sm:items-center sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-dialog-title"
        className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df] shadow-clay sm:max-h-[calc(100vh-2.5rem)]"
      >
        <div className="flex items-start justify-between gap-3 border-b-2 border-ink bg-white p-4">
          <div>
            <p id="generation-dialog-title" className="flex items-center gap-2 text-sm font-black text-ink">
              {titleIcon}
              {title}
            </p>
            <p className="mt-1 text-xs font-bold leading-5 text-ink/60">{description}</p>
          </div>
          <button
            type="button"
            aria-label="关闭生成状态"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-white text-ink shadow-clay-sm transition hover:-translate-y-0.5"
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="grid gap-4">
            {(status === 'generating' || safeProgress > 0) && (
              <ProgressBar value={safeProgress} label={progressLabel} />
            )}

            {status === 'failed' &&
              (failure ? (
                <FailureNotice title={failure.title} action={failure.action} />
              ) : (
                <FailureNotice title="生成失败" action="请调整素材后重新生成，或稍后再试。" />
              ))}

            {status !== 'failed' && failure && (
              <FailureNotice title={failure.title} action={failure.action} />
            )}

            {cloudJob && (
              <CloudJobPanel
                job={cloudJob}
                downloadUrl={downloadUrl}
                androidMotionPhotoUrl={androidMotionPhotoUrl}
                previewPhotoUrl={previewPhotoUrl}
                downloadingSource={downloadingSource}
                onDownload={onCloudDownload}
                onDelete={onDeleteCloudJob}
              />
            )}

            {exportResult && packageArtifact && (
              <ExportResultPanel
                result={exportResult}
                packageArtifact={packageArtifact}
                onDownload={onLocalDownload}
                aspectRatioId={aspectRatioId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CompatibilityLabTriggerButton({
  reportCountLabel,
  onClick,
}: {
  reportCountLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-20 right-4 z-40 inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-white px-3 text-xs font-black text-ink shadow-clay transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-[#23b7a4] lg:bottom-4"
    >
      <BadgeCheck size={15} className="text-[#23b7a4]" />
      {reportCountLabel}
    </button>
  );
}

function CompatibilityLabDialog({
  open,
  downloadContext,
  onOpenChange,
}: {
  open: boolean;
  downloadContext: CompatibilityDownloadContext | null;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onOpenChange, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/45 p-4 lg:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compatibility-lab-title"
        className="flex max-h-[min(84dvh,46rem)] w-[min(92vw,48rem)] flex-col overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df] shadow-clay"
      >
        <div className="flex items-start justify-between gap-2 border-b-2 border-ink bg-white p-2.5 lg:gap-3 lg:p-4">
          <div className="min-w-0">
            <p id="compatibility-lab-title" className="flex items-center gap-1.5 text-xs font-black text-ink lg:gap-2 lg:text-sm">
              <BadgeCheck size={18} className="text-[#23b7a4]" />
              机型众测
            </p>
            <p className="mt-1 break-all text-[11px] font-bold leading-4 text-ink/60 lg:text-xs lg:leading-5">
              {downloadContext
                ? `已触发下载：${downloadContext.fileName}`
                : '补充当前设备识别结果，用于完善兼容性判断。'}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭机型众测"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 border-ink bg-white text-ink shadow-clay-sm transition hover:-translate-y-0.5 lg:h-9 lg:w-9"
          >
            <X size={17} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-2.5 lg:p-4">
          <CompatibilityLabPanel
            key={downloadContext?.downloadedAt ?? 'manual'}
            downloadContext={downloadContext}
          />
        </div>
      </div>
    </div>
  );
}

function CompatibilityLabPanel({ downloadContext }: { downloadContext?: CompatibilityDownloadContext | null }) {
  const [testKit, setTestKit] = useState<CompatibilityTestKit | null>(null);
  const [form, setForm] = useState<CompatibilityFormState>(() => createInitialCompatibilityForm());
  const [status, setStatus] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitSuccessOpen, setIsSubmitSuccessOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const testKitResponse = await fetch(toApiUrl('/api/compatibility/test-kit'), { cache: 'no-store' });

      if (!testKitResponse.ok) {
        setStatus('兼容数据加载失败');
        return;
      }

      setTestKit((await testKitResponse.json()) as CompatibilityTestKit);
      setStatus(null);
    } catch {
      setStatus('兼容数据加载失败');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Load external compatibility lab state after mount.
    void refresh();
  }, [refresh]);

  const updateField = <K extends keyof CompatibilityFormState>(key: K, value: CompatibilityFormState[K]) => {
    setValidationErrors([]);
    setStatus(null);
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const updateViewer = (viewer: CompatibilityViewerId, outcome: CompatibilityViewerOutcome) => {
    setValidationErrors([]);
    setStatus(null);
    setForm((current) => ({
      ...current,
      viewers: {
        ...current.viewers,
        [viewer]: outcome,
      },
    }));
  };

  const submitReport = async () => {
    const validation = validateCompatibilityForm(form);

    if (validation.errors.length > 0) {
      setValidationErrors(validation.errors);
      setStatus(null);
      return;
    }

    if (!testKit) {
      setValidationErrors([]);
      setStatus('测试样本未就绪');
      return;
    }

    const viewers = compatibilityViewerOptions.map((option) => ({
      viewer: option.id,
      outcome: form.viewers[option.id] ?? 'not-tested',
    }));
    const payload: CompatibilityReportInput = {
      sampleId: testKit.sampleId,
      sampleSha256: testKit.sha256,
      osName: form.osName,
      downloadResult: form.downloadResult,
      transferPath: form.transferPath,
      viewers,
      deviceBrand: validation.text.deviceBrand,
      deviceModel: validation.text.deviceModel,
      osVersion: validation.text.osVersion,
      browserName: validation.text.browserName,
    };

    if (validation.text.browserVersion) {
      payload.browserVersion = validation.text.browserVersion;
    }

    if (validation.text.notes) {
      payload.notes = validation.text.notes;
    }

    setValidationErrors([]);
    setIsSubmitting(true);
    setStatus('提交中');

    try {
      const response = await fetch(toApiUrl('/api/compatibility/reports'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        setStatus(response.status === 429 ? '提交太频繁' : '提交失败');
        return;
      }

      setValidationErrors([]);
      setForm(createInitialCompatibilityForm());
      setStatus(null);
      setIsSubmitSuccessOpen(true);
    } catch {
      setStatus('提交失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const sampleUrl = testKit ? toApiUrl(testKit.downloadUrl) : null;

  return (
    <Panel title="机型众测" icon={<BadgeCheck size={18} />} compact>
      <div className="grid min-w-0 gap-2 lg:gap-3">
        {downloadContext && (
          <div className="rounded-lg border-2 border-ink bg-[#d9f99d] p-2 lg:p-3">
            <p className="text-[11px] font-black text-ink lg:text-xs">下载已触发</p>
            <p className="mt-1 break-all text-[11px] font-semibold leading-4 text-ink/65 lg:text-xs lg:leading-5">
              {downloadContext.fileName} / {new Date(downloadContext.downloadedAt).toLocaleString('zh-CN')}
            </p>
          </div>
        )}

        <div className="grid min-w-0 grid-cols-3 gap-1 lg:gap-2">
          <a
            href={sampleUrl ?? undefined}
            download={testKit?.fileName ?? 'motion-photo_MP.jpg'}
            aria-disabled={!sampleUrl}
            className={[
              'inline-flex h-9 min-w-0 items-center justify-center gap-1 rounded-lg border-2 border-ink px-1.5 text-[11px] font-black shadow-clay-sm transition lg:h-10 lg:gap-2 lg:px-3 lg:text-xs',
              sampleUrl ? 'bg-[#ff715b] text-white hover:-translate-y-0.5' : 'pointer-events-none bg-ink/15 text-ink/40',
            ].join(' ')}
          >
            <Download size={13} />
            下载样本
          </a>
          <a
            href={toApiUrl('/api/compatibility/reports.csv')}
            download="vidlive-compatibility-reports.csv"
            className="inline-flex h-9 min-w-0 items-center justify-center rounded-lg border-2 border-ink bg-white px-1.5 text-[11px] font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5 lg:h-10 lg:px-3 lg:text-xs"
          >
            CSV
          </a>
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            className="inline-flex h-9 min-w-0 items-center justify-center rounded-lg border-2 border-ink bg-white px-1.5 text-[11px] font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5 lg:h-10 lg:px-3 lg:text-xs"
          >
            刷新
          </button>
        </div>

        <div className="grid min-w-0 grid-cols-2 gap-1.5 lg:gap-2">
          <CompatibilityTextInput
            label="品牌"
            value={form.deviceBrand}
            placeholder="Huawei"
            onChange={(value) => updateField('deviceBrand', value)}
          />
          <CompatibilityTextInput
            label="机型"
            value={form.deviceModel}
            placeholder="Mate / Reno"
            onChange={(value) => updateField('deviceModel', value)}
          />
          <label className="grid w-full min-w-0 max-w-full gap-1 text-[11px] font-black text-ink/60 lg:text-xs">
            系统
            <select
              value={form.osName}
              onChange={(event) => updateField('osName', event.target.value as CompatibilityOsName)}
              className="box-border h-9 w-full min-w-0 max-w-full rounded-lg border-2 border-ink/15 bg-white px-1.5 text-xs font-black text-ink lg:h-10 lg:px-2 lg:text-sm"
            >
              <option value="Android">Android</option>
              <option value="HarmonyOS">HarmonyOS</option>
              <option value="Other">Other</option>
            </select>
          </label>
          <CompatibilityTextInput
            label="版本"
            value={form.osVersion}
            placeholder="14 / 4.2"
            onChange={(value) => updateField('osVersion', value)}
          />
          <CompatibilityTextInput
            label="浏览器"
            value={form.browserName}
            placeholder="Edge"
            onChange={(value) => updateField('browserName', value)}
          />
          <label className="grid w-full min-w-0 max-w-full gap-1 text-[11px] font-black text-ink/60 lg:text-xs">
            下载
            <select
              value={form.downloadResult}
              onChange={(event) => updateField('downloadResult', event.target.value as CompatibilityDownloadResult)}
              className="box-border h-9 w-full min-w-0 max-w-full rounded-lg border-2 border-ink/15 bg-white px-1.5 text-xs font-black text-ink lg:h-10 lg:px-2 lg:text-sm"
            >
              <option value="success">成功</option>
              <option value="failed">失败</option>
              <option value="unknown">未知</option>
            </select>
          </label>
        </div>

        <label className="grid w-full min-w-0 max-w-full gap-1 text-[11px] font-black text-ink/60 lg:text-xs">
          路径
          <select
            value={form.transferPath}
            onChange={(event) => updateField('transferPath', event.target.value as CompatibilityTransferPath)}
            className="box-border h-9 w-full min-w-0 max-w-full rounded-lg border-2 border-ink/15 bg-white px-1.5 text-xs font-black text-ink lg:h-10 lg:px-2 lg:text-sm"
          >
            <option value="browser-direct">浏览器直下</option>
            <option value="usb">USB</option>
            <option value="wechat">微信</option>
            <option value="qq">QQ</option>
            <option value="cloud-drive">网盘</option>
            <option value="unknown">未知</option>
          </select>
        </label>

        <div className="grid min-w-0 gap-2">
          {compatibilityViewerOptions.map((option) => (
            <div key={option.id} className="min-w-0 rounded-lg border-2 border-ink/15 bg-white p-1.5 lg:p-2">
              <p className="mb-1.5 truncate text-[11px] font-black text-ink lg:mb-2 lg:text-xs">{option.label}</p>
              <div className="grid min-w-0 grid-cols-4 gap-1">
                {compatibilityOutcomeOptions.map((outcome) => {
                  const active = (form.viewers[option.id] ?? 'not-tested') === outcome.id;

                  return (
                    <button
                      key={outcome.id}
                      type="button"
                      onClick={() => updateViewer(option.id, outcome.id)}
                      className={[
                        'h-7 min-w-0 rounded-md border px-1 text-[10px] font-black transition lg:h-8 lg:text-[11px]',
                        active
                          ? 'border-ink bg-[#d9f99d] text-ink shadow-clay-sm'
                          : 'border-ink/15 bg-[#f7f2ea] text-ink/55 hover:border-ink',
                      ].join(' ')}
                    >
                      {outcome.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <label className="grid w-full min-w-0 max-w-full gap-1 text-[11px] font-black text-ink/60 lg:text-xs">
          备注
          <textarea
            value={form.notes}
            maxLength={500}
            onChange={(event) => updateField('notes', event.target.value)}
            className="box-border min-h-14 w-full min-w-0 max-w-full rounded-lg border-2 border-ink/15 bg-white px-2 py-1.5 text-xs font-semibold text-ink lg:min-h-16 lg:px-3 lg:py-2 lg:text-sm"
          />
        </label>

        {validationErrors.length > 0 && (
          <div role="alert" className="grid gap-1.5 rounded-lg border-2 border-ink bg-[#ffe2dc] p-2 lg:gap-2 lg:p-3">
            <p className="text-[11px] font-black text-ink lg:text-xs">请先补充以下信息</p>
            <ul className="grid gap-1 text-[11px] font-bold leading-4 text-ink/70 lg:text-xs lg:leading-5">
              {validationErrors.map((error) => (
                <li key={error}>- {error}</li>
              ))}
            </ul>
          </div>
        )}

        <button
          type="button"
          disabled={isSubmitting}
          onClick={() => {
            void submitReport();
          }}
          className="inline-flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg border-2 border-ink bg-[#23b7a4] px-3 text-xs font-black text-white shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40 lg:h-11 lg:gap-2 lg:px-4 lg:text-sm"
        >
          <ShieldCheck size={16} />
          提交结果
        </button>

        {status && <p className="text-[11px] font-bold text-ink/60 lg:text-xs">{status}</p>}
      </div>
      <CompatibilitySubmitSuccessDialog open={isSubmitSuccessOpen} onOpenChange={setIsSubmitSuccessOpen} />
    </Panel>
  );
}

function CompatibilitySubmitSuccessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onOpenChange, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/45 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="compatibility-submit-success-title"
        aria-describedby="compatibility-submit-success-description"
        className="w-[min(86vw,22rem)] rounded-lg border-2 border-ink bg-white p-4 text-center shadow-clay"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border-2 border-ink bg-[#d9f99d] text-ink shadow-clay-sm">
          <CheckCircle2 size={24} />
        </div>
        <p id="compatibility-submit-success-title" className="mt-3 text-base font-black text-ink">
          提交成功
        </p>
        <p
          id="compatibility-submit-success-description"
          className="mx-auto mt-2 max-w-[17rem] text-sm font-bold leading-6 text-ink/65"
        >
          兼容结果已记录，将用于完善设备识别规则。
        </p>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5"
        >
          知道了
        </button>
      </div>
    </div>
  );
}

function CompatibilityTextInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid w-full min-w-0 max-w-full gap-1 text-[11px] font-black text-ink/60 lg:text-xs">
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="box-border h-9 w-full min-w-0 max-w-full rounded-lg border-2 border-ink/15 bg-white px-1.5 text-xs font-black text-ink placeholder:text-ink/30 lg:h-10 lg:px-2 lg:text-sm"
      />
    </label>
  );
}

function CloudJobPanel({
  job,
  downloadUrl,
  androidMotionPhotoUrl,
  previewPhotoUrl,
  downloadingSource,
  onDownload,
  onDelete,
}: {
  job: CloudJob;
  downloadUrl: string | null;
  androidMotionPhotoUrl: string | null;
  previewPhotoUrl: string | null;
  downloadingSource: CloudDownloadRequest['source'] | null;
  onDownload: (download: CloudDownloadRequest) => void;
  onDelete: () => Promise<void>;
}) {
  const [qrPreview, setQrPreview] = useState<{ downloadUrl: string; dataUrl: string } | null>(null);
  const statusCopy: Record<CloudJobStatus, string> = {
    queued: '排队中',
    processing: '处理中',
    completed: '已完成',
    failed: '处理失败',
    expired: '已过期',
    deleted: '已删除',
  };
  const canDownload = job.status === 'completed' && Boolean(job.artifact && downloadUrl);
  const canDownloadAndroidMotionPhoto = job.status === 'completed' && Boolean(job.androidMotionPhoto && androidMotionPhotoUrl);
  const canPreviewPhoto = job.status === 'completed' && Boolean(job.previewPhoto) && Boolean(previewPhotoUrl);
  const activeDownloadUrl = canDownloadAndroidMotionPhoto ? androidMotionPhotoUrl : canDownload ? downloadUrl : null;
  const anyDownloadBusy = Boolean(downloadingSource);
  const androidMotionPhotoBusy = downloadingSource === 'android-motion-photo';
  const packageDownloadBusy = downloadingSource === 'cloud-package';
  const androidRelevantWarnings = job.warnings.filter((warning) => {
    return !warning.includes('MakerNote') && !warning.includes('ContentIdentifier') && !warning.includes('Apple');
  });
  const qrDataUrl = qrPreview?.downloadUrl === activeDownloadUrl ? qrPreview.dataUrl : null;
  const downloadButtonClass =
    'inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink px-3 text-sm font-black shadow-clay-sm transition hover:-translate-y-0.5';
  const disabledDownloadButtonClass =
    'inline-flex h-11 cursor-not-allowed items-center justify-center gap-2 rounded-lg border-2 border-ink bg-ink/20 px-3 text-sm font-black text-ink/40 shadow-clay-sm';

  useEffect(() => {
    if (!activeDownloadUrl) {
      return;
    }

    let cancelled = false;

    QRCode.toDataURL(activeDownloadUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 180,
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
    })
      .then((nextQrDataUrl) => {
        if (!cancelled) {
          setQrPreview({ downloadUrl: activeDownloadUrl, dataUrl: nextQrDataUrl });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activeDownloadUrl]);

  return (
    <Panel title="安卓实况图" icon={<ImageIcon size={18} />}>
      <div className="rounded-lg border-2 border-ink bg-[#e4f7ff] p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-black text-ink">{statusCopy[job.status]}</p>
          <span className="rounded-lg border border-ink/15 bg-white px-2 py-1 text-xs font-black text-ink/65">
            {job.progress}%
          </span>
        </div>
        <p className="mt-2 break-all text-xs font-semibold leading-5 text-ink/60">任务 ID：{job.id}</p>
        <p className="mt-1 text-xs font-semibold leading-5 text-ink/60">
          过期时间：{new Date(job.expiresAt).toLocaleString('zh-CN')}
        </p>
      </div>

      {job.status === 'completed' && (
        <div className="mt-3 rounded-lg border-2 border-ink/15 bg-[#d9f99d] p-3">
          <p className="text-xs font-black text-ink">安卓验收</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-ink/65">
            下载单文件 motion-photo_MP.jpg，优先用 Google Photos 或主流视频平台打开。ColorOS / 鸿蒙系统相册可能只当普通照片显示。
          </p>
        </div>
      )}

      {canPreviewPhoto && previewPhotoUrl && (
        <div className="mt-3 rounded-lg border-2 border-ink/15 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-black text-ink">生成预览图</p>
            {job.previewPhoto && (
              <span className="text-xs font-black text-ink/55">{formatBytes(job.previewPhoto.sizeBytes)}</span>
            )}
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-ink/15 bg-[#f7f2ea]">
            <img src={previewPhotoUrl} alt="" className="max-h-72 w-full object-contain" />
          </div>
        </div>
      )}

      {job.error && (
        <div className="mt-3 rounded-lg border-2 border-ink bg-[#ffe2dc] p-3">
          <p className="text-xs font-black text-ink">{job.error.code}</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-ink/65">{job.error.message}</p>
        </div>
      )}

      {androidRelevantWarnings.length > 0 && (
        <div className="mt-3 rounded-lg border-2 border-ink/15 bg-[#fff4df] p-3">
          <p className="text-xs font-black text-ink">兼容提示</p>
          <ul className="mt-2 grid gap-1 text-xs font-semibold leading-5 text-ink/65">
            {androidRelevantWarnings.map((warning) => (
              <li key={warning}>- {warning}</li>
            ))}
          </ul>
        </div>
      )}

      {qrDataUrl && activeDownloadUrl && (
        <div
          aria-label="二维码发送到手机"
          className="mt-3 grid grid-cols-[96px,minmax(0,1fr)] gap-3 rounded-lg border-2 border-ink/15 bg-white p-3"
        >
          <img src={qrDataUrl} alt="" className="h-24 w-24 rounded-lg border border-ink/15 bg-white" />
          <div className="flex flex-col justify-center">
            <p className="text-sm font-black text-ink">手机扫码下载</p>
            <p className="mt-1 break-all text-xs font-semibold leading-5 text-ink/60">{activeDownloadUrl}</p>
          </div>
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {canDownloadAndroidMotionPhoto && androidMotionPhotoUrl ? (
          <button
            type="button"
            disabled={anyDownloadBusy}
            onClick={() => {
              onDownload({
                url: androidMotionPhotoUrl,
                fileName: job.androidMotionPhoto?.fileName ?? 'motion-photo_MP.jpg',
                source: 'android-motion-photo',
              });
            }}
            className={`${downloadButtonClass} h-12 bg-[#ff715b] text-white disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40 sm:col-span-2`}
          >
            {androidMotionPhotoBusy ? <Loader2 size={16} className="animate-spin" /> : <ImageIcon size={16} />}
            {androidMotionPhotoBusy ? '下载中' : '下载安卓实况图'}
          </button>
        ) : (
          <button type="button" disabled className={`${disabledDownloadButtonClass} sm:col-span-2`}>
            <ImageIcon size={16} />
            {job.status === 'completed' ? '安卓实况图未生成' : '下载安卓实况图'}
          </button>
        )}
        <button
          type="button"
          disabled={!canDownload || anyDownloadBusy}
          onClick={() => {
            if (job.artifact && downloadUrl) {
              onDownload({
                url: downloadUrl,
                fileName: job.artifact.fileName,
                source: 'cloud-package',
              });
            }
          }}
          className={`${downloadButtonClass} bg-[#23b7a4] text-white disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40`}
        >
          {packageDownloadBusy ? <Loader2 size={16} className="animate-spin" /> : <FileArchive size={16} />}
          {packageDownloadBusy ? '下载中' : '完整 ZIP'}
        </button>
        <button
          type="button"
          onClick={() => {
            void onDelete();
          }}
          className={`${downloadButtonClass} bg-white text-ink`}
        >
          <CloudOff size={16} />
          删除
        </button>
      </div>
    </Panel>
  );
}

function FailureNotice({ title, action }: { title: string; action: string }) {
  return (
    <div className="flex gap-3 rounded-lg border-2 border-ink bg-[#ffe2dc] p-4 text-sm shadow-clay-sm">
      <AlertTriangle className="mt-0.5 shrink-0 text-[#ff715b]" size={18} />
      <div>
        <p className="font-black text-ink">{title}</p>
        <p className="mt-1 font-medium text-ink/65">{action}</p>
      </div>
    </div>
  );
}

function InfoTooltip({ text, className = '' }: { text: string; className?: string }) {
  return (
    <span className={['group/tooltip inline-flex', className].join(' ')}>
      <button
        type="button"
        aria-label="查看说明"
        className="inline-flex h-7 w-7 cursor-help items-center justify-center rounded-full border border-ink/15 bg-white text-ink/55 shadow-clay-sm transition hover:border-ink hover:text-ink focus:outline-none focus:ring-2 focus:ring-[#23b7a4]"
      >
        <Info size={14} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-[90] mt-2 hidden w-72 max-w-[calc(100vw-2rem)] rounded-lg border-2 border-ink bg-white p-3 text-xs font-semibold leading-5 text-ink/70 shadow-clay-sm group-hover/tooltip:block group-focus-within/tooltip:block"
      >
        {text}
      </span>
    </span>
  );
}

function PresetButton({ active, presetId, onClick }: { active: boolean; presetId: ExportPresetId; onClick: () => void }) {
  const preset = exportPresets[presetId];

  return (
    <div
      className={[
        'relative z-0 rounded-lg border-2 transition hover:z-40 hover:-translate-y-0.5 focus-within:z-40',
        active ? 'border-ink bg-[#d9f99d] shadow-clay-sm' : 'border-ink/15 bg-white hover:border-ink',
      ].join(' ')}
    >
      <button type="button" onClick={onClick} className="block w-full p-3 pr-11 text-left">
        <span className="block text-sm font-black">{preset.label}</span>
        <span className="mt-1 block text-xs leading-5 text-ink/65">{preset.target}</span>
      </button>
      <InfoTooltip text={presetHelpText[presetId]} className="absolute right-3 top-1/2 -translate-y-1/2" />
    </div>
  );
}

function TimelineMarkButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-10 items-center justify-center rounded-lg border-2 border-ink bg-[#e4f7ff] px-3 text-xs font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-ink/35"
    >
      {label}
    </button>
  );
}

function Panel({
  title,
  icon,
  children,
  compact = false,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <section className={['clay-card min-w-0 bg-white', compact ? 'p-2.5 lg:p-4' : 'p-4'].join(' ')}>
      <div
        className={[
          'flex items-center gap-2 font-black text-ink',
          compact ? 'mb-2 text-xs lg:mb-3 lg:text-sm' : 'mb-3 text-sm',
        ].join(' ')}
      >
        <span className="text-[#ff715b]">{icon}</span>
        {title}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'coral' | 'mint' | 'sun' | 'sky' }) {
  const toneClass = {
    coral: 'bg-[#ff715b]',
    mint: 'bg-[#23b7a4]',
    sun: 'bg-[#f7c948]',
    sky: 'bg-[#6aa9ff]',
  }[tone];

  return (
    <div className="clay-card min-h-24 bg-white p-4">
      <span className={`mb-3 block h-2 w-12 rounded-lg border border-ink/20 ${toneClass}`} />
      <p className="text-xs font-black uppercase text-ink/45">{label}</p>
      <p className="mt-2 break-words text-sm font-black text-ink">{value}</p>
    </div>
  );
}

function ModeButton({
  active,
  label,
  description,
  tooltip,
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  tooltip: string;
  onClick: () => void;
}) {
  return (
    <div
      className={[
        'relative z-0 rounded-lg border-2 transition hover:z-40 hover:-translate-y-0.5 focus-within:z-40',
        active ? 'border-ink bg-[#d9f99d] shadow-clay-sm' : 'border-ink/15 bg-white hover:border-ink',
      ].join(' ')}
    >
      <button type="button" onClick={onClick} className="block w-full p-3 pr-11 text-left">
        <span className="flex items-center gap-2 text-sm font-black text-ink">
          {active && <CheckCircle2 size={15} className="text-[#23b7a4]" />}
          {label}
        </span>
        <span className="mt-1 block text-xs font-semibold text-ink/60">{description}</span>
      </button>
      <InfoTooltip text={tooltip} className="absolute right-3 top-1/2 -translate-y-1/2" />
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  id,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  id?: string;
}) {
  const safeMax = Math.max(max, min);

  return (
    <label className="mb-3 block last:mb-0">
      <span className="mb-2 flex items-center justify-between gap-3 text-sm font-bold text-ink/70">
        <span>{label}</span>
        <span className="font-mono text-xs text-ink">{formatSeconds(value)}</span>
      </span>
      <input
        id={id}
        type="range"
        value={clamp(value, min, safeMax)}
        min={min}
        max={safeMax}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        onInput={(event) => onChange(Number(event.currentTarget.value))}
        className="h-7 w-full accent-[#ff715b]"
      />
    </label>
  );
}

function ReadonlyTimelineField({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="mb-3 rounded-lg border border-ink/10 bg-[#f7f2ea] px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-sm font-bold text-ink/70">
        <span>{label}</span>
        <span className="font-mono text-xs text-ink">{formatSeconds(value)}</span>
      </div>
      <p className="mt-1 text-xs font-bold text-ink/50">{hint}</p>
    </div>
  );
}

function NumberRangeField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mt-3 block">
      <span className="mb-2 flex items-center justify-between gap-3 text-sm font-bold text-ink/70">
        <span>{label}</span>
        <span className="font-mono text-xs text-ink">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        value={clamp(value, min, max)}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[#23b7a4]"
      />
    </label>
  );
}

function ToggleButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'h-10 rounded-lg border-2 px-2 text-sm font-black transition hover:-translate-y-0.5',
        active ? 'border-ink bg-[#d9f99d] shadow-clay-sm' : 'border-ink/15 bg-white text-ink/70 hover:border-ink',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function StatusPill({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-white px-3 text-sm font-black text-ink shadow-clay-sm">
      {icon}
      {label}
    </div>
  );
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const isComplete = value >= 100;

  return (
    <div className="clay-card bg-white p-4">
      <div className="mb-2 flex items-center justify-between text-sm font-black text-ink">
        <span className="flex items-center gap-2">
          {!isComplete && <Loader2 size={16} className="animate-spin text-[#6aa9ff]" />}
          {isComplete && <CheckCircle2 size={16} className="text-[#23b7a4]" />}
          {label}
        </span>
        <span>{value}%</span>
      </div>
      <div className="h-4 overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df]">
        <div className="h-full rounded-md bg-[#6aa9ff] transition-all" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
