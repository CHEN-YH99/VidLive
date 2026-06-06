'use client';

import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  Clock3,
  CloudOff,
  Download,
  FileArchive,
  Film,
  ImageIcon,
  Info,
  Loader2,
  Lock,
  MonitorDown,
  Palette,
  PlayCircle,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { type FileRejection, useDropzone } from 'react-dropzone';
import QRCode from 'qrcode';
import {
  aspectRatios,
  exportPresets,
  failureAdvice,
  productLimits,
  supportedInputs,
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
  local: '只在浏览器内解析和打包，不上传素材；适合快速预览和普通素材包。安卓实况单文件以云端结果为准。',
  cloud:
    '把素材提交到后端处理，用 FFmpeg 生成 Android Motion Photo 单文件、预览图和完整素材包；适合最终导出和真机验证。',
} as const;

const presetHelpText: Record<ExportPresetId, string> = {
  'standard-live-photo': '默认 3 秒，优先保留原素材比例，适合 Google Photos 或系统相册的标准动态照片验证。',
  'ios-lock-screen': '默认 2 秒，优先 9:16 竖屏，适合安卓系统相册识别和手机壁纸素材验证。',
  'social-fallback': '输出 MP4 / GIF / WebP 等兜底格式，不追求严格实况结构；适合社交平台无法识别动态照片时发布。',
};

type CloudJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'expired' | 'deleted';

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
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
  const [failureReason, setFailureReason] = useState<FailureReason | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [exportResult, setExportResult] = useState<LocalExportResult | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [cloudConsentConfirmed, setCloudConsentConfirmed] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);

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
        setFailureReason(rejectionReason);
        return;
      }

      const selectedFile = acceptedFiles[0];

      if (!selectedFile || !isSupportedInput(selectedFile)) {
        setFailureReason('unsupported-format');
        return;
      }

      setIsReading(true);
      setFailureReason(null);
      setCoverUrl(null);
      setPreviewPlaybackFailed(false);
      setPlayheadSeconds(0);
      setExportResult(null);
      setCloudJob(null);
      setCloudConsentConfirmed(false);
      setGenerationProgress(0);

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
    [draft.presetId],
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
    file && previewUrl && metadata && !isReading && !isGenerating && !cloudBusy && !cloudConsentRequired,
  );
  const packageArtifact = exportResult?.artifacts.find((artifact) => artifact.kind === 'package') ?? null;

  const updatePreset = (presetId: ExportPresetId) => {
    setExportResult(null);
    setCloudJob(null);
    setDraft((current) => getDefaultDraftForPreset(presetId, current, metadata));
  };

  const updateStart = (value: number) => {
    setExportResult(null);
    setCloudJob(null);
    setDraft((current) => {
      const preset = exportPresets[current.presetId];
      const nextClipDuration = getTargetClipDuration(preset, sourceDurationMax);
      const nextStart = clamp(value, 0, Math.max(0, sourceDurationMax - nextClipDuration));
      const nextEnd = nextStart + nextClipDuration;
      const nextKeyframe = nextStart + nextClipDuration / 2;

      return {
        ...current,
        startSeconds: nextStart,
        endSeconds: nextEnd,
        keyframeSeconds: nextKeyframe,
      };
    });
  };

  const updateKeyframe = (value: number) => {
    setExportResult(null);
    setCloudJob(null);
    setDraft((current) => ({
      ...current,
      keyframeSeconds: clamp(value, current.startSeconds, current.endSeconds),
    }));
  };

  const handleGenerate = async () => {
    if (!file || !previewUrl || !metadata) {
      setFailureReason('metadata-read-failed');
      return;
    }

    if (draft.mode === 'cloud' && !cloudConsentConfirmed) {
      setFailureReason('cloud-required');
      return;
    }

    setFailureReason(null);
    setExportResult(null);
    setCloudJob(null);
    setIsGenerating(true);
    setGenerationProgress(draft.mode === 'cloud' ? 8 : 18);

    try {
      if (draft.mode === 'cloud') {
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
        setCloudJob(nextJob);
        setGenerationProgress(nextJob.progress);
        await pollCloudJobUntilSettled(nextJob.id);
        return;
      }

      setGenerationProgress(42);
      const result = await generateLocalExport(file, previewUrl, draft, metadata);
      setGenerationProgress(100);
      setExportResult(result);
    } catch (error) {
      setGenerationProgress(0);
      setFailureReason(getFailureFromExportError(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const submitCompatibilityFeedback = async (savedToPhotos: boolean, lockScreenPlayed: boolean) => {
    setFeedbackStatus('提交中');

    try {
      await fetch(toApiUrl('/api/v1/compatibility-feedback'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          presetId: draft.presetId,
          device: 'browser',
          iosVersion: 'unknown',
          savedToPhotos,
          lockScreenPlayed,
          notes: metadata?.name ?? '',
        }),
      });
      setFeedbackStatus('已记录');
    } catch {
      setFeedbackStatus('提交失败');
    }
  };

  return (
    <main className="min-h-screen bg-[#fff4df] text-ink">
      <section className="border-b-2 border-ink/10 bg-[#fff4df]">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
          <header className="grid gap-3 lg:grid-cols-[auto_minmax(280px,1fr)_auto] lg:items-center">
            <div className="inline-flex h-11 items-center gap-2 rounded-lg border-2 border-ink bg-white px-3 font-black shadow-clay-sm">
              <PlayCircle size={18} className="text-[#ff715b]" />
              VidLive
            </div>

            <SavePathPanel />

            <div className="flex flex-wrap gap-2 lg:justify-end">
              <StatusPill icon={<ShieldCheck size={15} />} label="本地优先" />
              <StatusPill icon={<Clock3 size={15} />} label="1-3 秒实况" />
              <StatusPill icon={<ImageIcon size={15} />} label="安卓单文件" />
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
              />

              {currentFailure && <FailureNotice title={currentFailure.title} action={currentFailure.action} />}

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
                />
                <CoverPreview coverUrl={coverUrl} isGif={Boolean(file && isGif(file))} open={open} />
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
                    label="起点"
                    value={draft.startSeconds}
                    min={0}
                    max={startMax}
                    step={0.1}
                    onChange={updateStart}
                  />
                  <ReadonlyTimelineField
                    label="终点"
                    value={draft.endSeconds}
                    hint={`起点 + ${formatSeconds(clipTargetDuration)}`}
                  />
                  <RangeField
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
                  <Panel title="AI 关键帧" icon={<ImageIcon size={18} />}>
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

              {(isGenerating || generationProgress > 0 || cloudBusy) && (
                <ProgressBar
                  value={generationProgress}
                  label={draft.mode === 'cloud' || cloudJob ? '安卓实况图生成中' : isGenerating ? '本地打包中' : '生成完成'}
                />
              )}

              {cloudJob && (
                <CloudJobPanel
                  job={cloudJob}
                  downloadUrl={cloudJob.artifact ? toApiUrl(cloudJob.artifact.downloadUrl) : null}
                  androidMotionPhotoUrl={
                    cloudJob.androidMotionPhoto ? toApiUrl(cloudJob.androidMotionPhoto.downloadUrl) : null
                  }
                  previewPhotoUrl={cloudJob.previewPhoto ? toApiUrl(cloudJob.previewPhoto.downloadUrl) : null}
                  onDownload={(url) => {
                    window.location.assign(toApiUrl(url));
                  }}
                  onDelete={async () => {
                    await fetch(toApiUrl(`/api/conversions/cloud-jobs/${cloudJob.id}`), {
                      method: 'DELETE',
                    });
                    setCloudJob(null);
                    setGenerationProgress(0);
                  }}
                />
              )}

              {exportResult || cloudJob?.status === 'completed' ? (
                <Panel title="安卓反馈" icon={<ShieldCheck size={18} />}>
                  <div className="grid grid-cols-2 gap-2">
                    <ToggleButton
                      active={feedbackStatus === '已记录'}
                      label="识别成功"
                      onClick={() => {
                        void submitCompatibilityFeedback(true, false);
                      }}
                    />
                    <ToggleButton
                      active={feedbackStatus === '提交失败'}
                      label="未识别"
                      onClick={() => {
                        void submitCompatibilityFeedback(false, false);
                      }}
                    />
                  </div>
                  {feedbackStatus && <p className="mt-2 text-xs font-bold text-ink/60">{feedbackStatus}</p>}
                </Panel>
              ) : null}

              {exportResult && packageArtifact && (
                <ExportResultPanel
                  result={exportResult}
                  packageArtifact={packageArtifact}
                  onDownload={(artifact) => downloadBlob(artifact.blob, artifact.fileName)}
                />
              )}
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
                      setExportResult(null);
                      setCloudJob(null);
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
                      setExportResult(null);
                      setCloudJob(null);
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
                        setExportResult(null);
                        setCloudJob(null);
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
                      setExportResult(null);
                      setCloudJob(null);
                      setDraft((current) => ({ ...current, fitMode: 'cover' as FitMode }));
                    }}
                  />
                  <ToggleButton
                    active={draft.fitMode === 'contain'}
                    label="补背景"
                    onClick={() => {
                      setExportResult(null);
                      setCloudJob(null);
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
                          setExportResult(null);
                          setCloudJob(null);
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
                    setExportResult(null);
                    setCloudJob(null);
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
                      setExportResult(null);
                      setCloudJob(null);
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
                      setExportResult(null);
                      setCloudJob(null);
                      setDraft((current) => ({ ...current, flipHorizontal: !current.flipHorizontal }));
                    }}
                  />
                  <ToggleButton
                    active={draft.flipVertical}
                    label="垂直翻转"
                    onClick={() => {
                      setExportResult(null);
                      setCloudJob(null);
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
                    setExportResult(null);
                    setCloudJob(null);
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
                    setExportResult(null);
                    setCloudJob(null);
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
                    setExportResult(null);
                    setCloudJob(null);
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

              <button
                type="button"
                disabled={!canGenerate}
                onClick={handleGenerate}
                className="sticky bottom-3 z-20 inline-flex h-12 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40 lg:static"
              >
                {isGenerating ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
                {isGenerating
                  ? draft.mode === 'cloud'
                    ? '生成实况图'
                    : '正在生成'
                  : draft.mode === 'cloud'
                    ? '生成安卓实况图'
                    : '生成文件'}
              </button>
            </aside>
          </div>

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
}) {
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
            支持 MP4、MOV、GIF。100MB 内默认本地处理；超过本地上限会切到云端兜底提示。
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
        {previewUrl && file ? (
          isGif(file) ? (
            <img src={previewUrl} alt="" className="h-full min-h-52 w-full object-contain" />
          ) : (
            <video
              src={previewUrl}
              className="h-full min-h-52 w-full object-contain"
              muted={draft.muted}
              playsInline
              preload="metadata"
              controls
              onError={onPlaybackError}
              onCanPlay={onPlaybackReady}
              onLoadedMetadata={(event) => onPlaybackTimeChange(event.currentTarget.currentTime)}
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
            浏览器无法预览此视频，云端仍可生成效果图和动图。
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
}: {
  file: File | null;
  previewUrl: string | null;
  draft: ConversionDraft;
  playbackFailed: boolean;
  onPlaybackError: () => void;
  onPlaybackReady: () => void;
  onPlaybackTimeChange: (seconds: number) => void;
}) {
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
          src={previewUrl}
          className="h-full max-h-[520px] min-h-80 w-full object-contain"
          controls
          muted={draft.muted}
          playsInline
          preload="metadata"
          onError={onPlaybackError}
          onCanPlay={onPlaybackReady}
          onLoadedMetadata={(event) => onPlaybackTimeChange(event.currentTarget.currentTime)}
          onTimeUpdate={(event) => onPlaybackTimeChange(event.currentTarget.currentTime)}
        />
      )}
      {!isGif(file) && playbackFailed && (
        <div className="absolute inset-x-4 bottom-4 rounded-lg border border-ink/20 bg-white/95 p-3 text-sm font-bold leading-6 text-ink shadow-clay-sm">
          浏览器无法播放当前编码，提交云端任务后可查看生成效果图。
        </div>
      )}
    </section>
  );
}

function CoverPreview({ coverUrl, isGif, open }: { coverUrl: string | null; isGif: boolean; open: () => void }) {
  return (
    <section className="clay-card grid gap-3 bg-white p-4">
      <div>
        <p className="mb-2 text-sm font-black text-ink">关键帧预览</p>
        <div className="aspect-[9/16] w-full overflow-hidden rounded-lg border-2 border-ink/15 bg-[#fff4df]">
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
        text: '手机直接下载 motion-photo_MP.jpg，用系统相册或 Google Photos 打开检查动态照片入口。',
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
      title: 'Pro 验证',
      icon: <BadgeCheck size={18} />,
      content: (
        <div className="grid h-full grid-rows-2 gap-2">
          <div className="flex flex-col justify-center rounded-lg border-2 border-ink/15 bg-white p-3">
            <p className="text-sm font-black text-ink">Free</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-ink/60">每日 5 次、标准实况图、完整 ZIP。</p>
          </div>
          <div className="flex flex-col justify-center rounded-lg border-2 border-ink bg-[#d9f99d] p-3 shadow-clay-sm">
            <p className="text-sm font-black text-ink">Pro Monthly</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-ink/65">
              批量处理、4K 素材、云端优先队列、历史记录。
            </p>
          </div>
        </div>
      ),
    },
    {
      id: 'toolbox',
      title: '扩展工具箱',
      icon: <Film size={18} />,
      content: (
        <div className="grid h-full grid-rows-5 gap-1.5">
          <ToolboxMiniItem label="Video/GIF to Android Motion Photo" status="available" />
          <ToolboxMiniItem label="安卓相册识别矩阵" status="preview" />
          <ToolboxMiniItem label="Motion Photo to GIF/MP4" status="preview" />
          <ToolboxMiniItem label="Image to Motion Photo" status="preview" />
          <ToolboxMiniItem label="AI Image Motion" status="planned" />
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

  return (
    <div className="flex h-full items-center justify-between gap-2 rounded-lg border border-ink/15 bg-white px-2 py-1">
      <span className="truncate text-xs font-black text-ink">{label}</span>
      <span className={`shrink-0 rounded-md border border-ink/15 px-2 py-0.5 text-[10px] font-black text-ink/65 ${statusClass}`}>
        {status}
      </span>
    </div>
  );
}

function ExportResultPanel({
  result,
  packageArtifact,
  onDownload,
}: {
  result: LocalExportResult;
  packageArtifact: LocalExportArtifact;
  onDownload: (artifact: LocalExportArtifact) => void;
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
        <div aria-label="导出结果预览" className="mt-3 overflow-hidden rounded-lg border-2 border-ink bg-ink">
          {previewArtifact.kind === 'cover' ? (
            <img src={resultPreviewUrl} alt="" className="h-44 w-full object-contain" />
          ) : (
            <video src={resultPreviewUrl} className="h-44 w-full object-contain" muted playsInline controls />
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

function CloudJobPanel({
  job,
  downloadUrl,
  androidMotionPhotoUrl,
  previewPhotoUrl,
  onDownload,
  onDelete,
}: {
  job: CloudJob;
  downloadUrl: string | null;
  androidMotionPhotoUrl: string | null;
  previewPhotoUrl: string | null;
  onDownload: (url: string) => void;
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
  const canDownload = job.status === 'completed' && Boolean(job.artifact);
  const canDownloadAndroidMotionPhoto = job.status === 'completed' && Boolean(job.androidMotionPhoto && androidMotionPhotoUrl);
  const canPreviewPhoto = job.status === 'completed' && Boolean(job.previewPhoto) && Boolean(previewPhotoUrl);
  const activeDownloadUrl = canDownloadAndroidMotionPhoto ? androidMotionPhotoUrl : canDownload ? downloadUrl : null;
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
            下载单文件 motion-photo_MP.jpg，用系统相册或 Google Photos 打开，检查动态照片/实况入口。
          </p>
        </div>
      )}

      {canPreviewPhoto && previewPhotoUrl && (
        <div className="mt-3 rounded-lg border-2 border-ink/15 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-black text-ink">生成效果图</p>
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
          <a
            href={androidMotionPhotoUrl}
            download={job.androidMotionPhoto?.fileName ?? 'motion-photo_MP.jpg'}
            className={`${downloadButtonClass} h-12 bg-[#ff715b] text-white sm:col-span-2`}
          >
            <ImageIcon size={16} />
            下载安卓实况图
          </a>
        ) : (
          <button type="button" disabled className={`${disabledDownloadButtonClass} sm:col-span-2`}>
            <ImageIcon size={16} />
            {job.status === 'completed' ? '安卓实况图未生成' : '下载安卓实况图'}
          </button>
        )}
        <button
          type="button"
          disabled={!canDownload}
          onClick={() => {
            if (job.artifact) {
              onDownload(job.artifact.downloadUrl);
            }
          }}
          className={`${downloadButtonClass} bg-[#23b7a4] text-white disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40`}
        >
          <FileArchive size={16} />
          完整 ZIP
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

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="clay-card bg-white p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-black text-ink">
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const safeMax = Math.max(max, min);

  return (
    <label className="mb-3 block last:mb-0">
      <span className="mb-2 flex items-center justify-between gap-3 text-sm font-bold text-ink/70">
        <span>{label}</span>
        <span className="font-mono text-xs text-ink">{formatSeconds(value)}</span>
      </span>
      <input
        type="range"
        value={clamp(value, min, safeMax)}
        min={min}
        max={safeMax}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
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
  return (
    <div className="clay-card bg-white p-4">
      <div className="mb-2 flex items-center justify-between text-sm font-black text-ink">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="h-4 overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df]">
        <div className="h-full rounded-md bg-[#6aa9ff] transition-all" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
