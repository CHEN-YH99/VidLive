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
  type ExportPresetId,
  type FailureReason,
  type FitMode,
  type VideoMetadata,
} from '@vidlive/shared';
import { captureCoverFrame, inspectImageLikeFile, inspectVideoFile, isSupportedInput } from '@/lib/file-inspector';
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

function getDefaultDraftForPreset(
  presetId: ExportPresetId,
  previous: ConversionDraft,
  metadata: VideoMetadata | null,
): ConversionDraft {
  const preset = exportPresets[presetId];
  const maxDuration = metadata?.durationSeconds ?? preset.defaultDurationSeconds;
  const clipDuration = Math.min(preset.defaultDurationSeconds, maxDuration);
  const endSeconds = Math.max(clipDuration, productLimits.minDurationSeconds);
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

function toApiUrl(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  return `${apiBaseUrl}${value}`;
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

function createKeyframeSuggestions(metadata: VideoMetadata | null): KeyframeSuggestion[] {
  const duration = Math.max(1, Math.min(metadata?.durationSeconds ?? 0, 30));

  if (!metadata?.durationSeconds) {
    return [];
  }

  const verticalBonus = metadata.height && metadata.width && metadata.height > metadata.width ? 8 : 0;

  return [
    {
      seconds: Math.round((duration / 2) * 10) / 10,
      score: 86 + verticalBonus,
      reasons: ['片段中点稳定', '默认封面候选'],
    },
    {
      seconds: Math.round(Math.max(0.2, duration * 0.38) * 10) / 10,
      score: 78,
      reasons: ['避开开头黑场', '保留动作起势'],
    },
    {
      seconds: Math.round(Math.min(duration - 0.2, duration * 0.68) * 10) / 10,
      score: 74 + verticalBonus,
      reasons: ['避开结尾停顿', '适合锁屏复测'],
    },
  ].sort((left, right) => right.score - left.score);
}

export function VidLiveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [draft, setDraft] = useState<ConversionDraft>(initialDraft);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [failureReason, setFailureReason] = useState<FailureReason | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [exportResult, setExportResult] = useState<LocalExportResult | null>(null);
  const [cloudJob, setCloudJob] = useState<CloudJob | null>(null);
  const [cloudConsentConfirmed, setCloudConsentConfirmed] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);

  const refreshCloudJob = useCallback(async (jobId: string) => {
    const response = await fetch(toApiUrl(`/api/conversions/cloud-jobs/${jobId}`));

    if (!response.ok) {
      setFailureReason(response.status === 404 ? 'expired-link' : 'cloud-timeout');
      return;
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
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!cloudJob || !isCloudJobActive(cloudJob)) {
      return;
    }

    const jobId = cloudJob.id;
    const timer = window.setInterval(() => {
      void refreshCloudJob(jobId);
    }, 1_500);

    return () => {
      window.clearInterval(timer);
    };
  }, [cloudJob, refreshCloudJob]);

  useEffect(() => {
    if (!previewUrl || !file || isGif(file)) {
      return;
    }

    let cancelled = false;

    captureCoverFrame(previewUrl, draft.keyframeSeconds).then((frame) => {
      if (!cancelled) {
        setCoverUrl(frame);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [draft.keyframeSeconds, file, previewUrl]);

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
        URL.revokeObjectURL(objectUrl);
        setFailureReason('metadata-read-failed');
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
  const keyframeSuggestions = useMemo(() => createKeyframeSuggestions(metadata), [metadata]);
  const durationMax = metadata?.durationSeconds ?? Math.max(draft.endSeconds, selectedPreset.defaultDurationSeconds);
  const currentFailure = failureReason ? failureAdvice[failureReason] : null;
  const clipDuration = Math.max(0, draft.endSeconds - draft.startSeconds);
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
      const nextStart = clamp(value, 0, Math.max(0, current.endSeconds - productLimits.minDurationSeconds));
      const nextKeyframe = clamp(current.keyframeSeconds, nextStart, current.endSeconds);

      return {
        ...current,
        startSeconds: nextStart,
        keyframeSeconds: nextKeyframe,
      };
    });
  };

  const updateEnd = (value: number) => {
    setExportResult(null);
    setCloudJob(null);
    setDraft((current) => {
      const nextEnd = clamp(value, current.startSeconds + productLimits.minDurationSeconds, durationMax);
      const nextKeyframe = clamp(current.keyframeSeconds, current.startSeconds, nextEnd);

      return {
        ...current,
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
          setFailureReason(response.status === 413 ? 'file-too-large' : 'cloud-timeout');
          return;
        }

        const nextJob = (await response.json()) as CloudJob;
        setCloudJob(nextJob);
        setGenerationProgress(nextJob.progress);
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
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex h-11 items-center gap-2 rounded-lg border-2 border-ink bg-white px-3 font-black shadow-clay-sm">
              <PlayCircle size={18} className="text-[#ff715b]" />
              VidLive
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusPill icon={<ShieldCheck size={15} />} label="本地优先" />
              <StatusPill icon={<Clock3 size={15} />} label="1-30 秒" />
              <StatusPill icon={<FileArchive size={15} />} label="素材包导出" />
            </div>
          </header>

          <div className="grid flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_410px]">
            <div className="flex flex-col gap-5">
              <UploadPanel
                file={file}
                previewUrl={previewUrl}
                draft={draft}
                isReading={isReading}
                isDragActive={isDragActive}
                getRootProps={getRootProps}
                getInputProps={getInputProps}
                open={open}
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

              <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_230px]">
                <MediaPreview file={file} previewUrl={previewUrl} draft={draft} />
                <CoverPreview coverUrl={coverUrl} isGif={Boolean(file && isGif(file))} open={open} />
              </section>

              <SavePathPanel presetId={draft.presetId} />
            </div>

            <aside className="flex flex-col gap-4">
              <Panel title="Phase 1 闭环" icon={<BadgeCheck size={18} />}>
                <div className="grid grid-cols-4 gap-2">
                  {phaseSteps.map((step) => (
                    <div
                      key={step.label}
                      className="flex min-h-16 flex-col items-center justify-center rounded-lg border-2 border-ink/15 bg-white text-xs font-black text-ink"
                    >
                      {step.icon}
                      <span className="mt-1">{step.label}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="处理模式" icon={<CloudOff size={18} />}>
                <div className="grid grid-cols-2 gap-2">
                  <ModeButton
                    active={draft.mode === 'local'}
                    label="本地"
                    description="不上传素材"
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
                    description="元数据实验"
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

              <Panel title="Pro 验证" icon={<BadgeCheck size={18} />}>
                <div className="grid gap-2">
                  <div className="rounded-lg border-2 border-ink/15 bg-white p-3">
                    <p className="text-sm font-black text-ink">Free</p>
                    <p className="mt-1 text-xs font-semibold leading-5 text-ink/60">每日 5 次、本地素材包、标准预设。</p>
                  </div>
                  <div className="rounded-lg border-2 border-ink bg-[#d9f99d] p-3 shadow-clay-sm">
                    <p className="text-sm font-black text-ink">Pro Monthly</p>
                    <p className="mt-1 text-xs font-semibold leading-5 text-ink/65">
                      批量处理、4K 输出、云端优先队列、历史记录。
                    </p>
                  </div>
                </div>
              </Panel>

              <Panel title="扩展工具箱" icon={<Film size={18} />}>
                <div className="grid gap-2">
                  <ToolboxItem label="Video/GIF to Live Photo 素材包" status="available" />
                  <ToolboxItem label="相册 Live Photo 写入" status="preview" />
                  <ToolboxItem label="Live Photo to GIF/MP4" status="preview" />
                  <ToolboxItem label="Image to Live Photo" status="preview" />
                  <ToolboxItem label="AI Image Motion" status="planned" />
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

              <Panel title="时间轴" icon={<Scissors size={18} />}>
                <RangeField
                  label="起点"
                  value={draft.startSeconds}
                  min={0}
                  max={Math.max(0, draft.endSeconds - productLimits.minDurationSeconds)}
                  step={0.1}
                  onChange={updateStart}
                />
                <RangeField
                  label="终点"
                  value={draft.endSeconds}
                  min={draft.startSeconds + productLimits.minDurationSeconds}
                  max={durationMax}
                  step={0.1}
                  onChange={updateEnd}
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
                  当前片段：{formatSeconds(clipDuration)}
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
                    云端上传确认：同意上传当前素材，临时文件保留 24 小时，可在任务完成后手动删除。
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
                    ? '提交任务'
                    : '正在生成'
                  : draft.mode === 'cloud'
                    ? '提交云端任务'
                    : '生成文件'}
              </button>

              {(isGenerating || generationProgress > 0 || cloudBusy) && (
                <ProgressBar
                  value={generationProgress}
                  label={draft.mode === 'cloud' || cloudJob ? '云端任务处理中' : isGenerating ? '本地打包中' : '生成完成'}
                />
              )}

              {cloudJob && (
                <CloudJobPanel
                  job={cloudJob}
                  downloadUrl={cloudJob.artifact ? toApiUrl(cloudJob.artifact.downloadUrl) : null}
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
                <Panel title="兼容反馈" icon={<ShieldCheck size={18} />}>
                  <div className="grid grid-cols-2 gap-2">
                    <ToggleButton
                      active={feedbackStatus === '已记录'}
                      label="保存成功"
                      onClick={() => {
                        void submitCompatibilityFeedback(true, draft.presetId === 'ios-lock-screen');
                      }}
                    />
                    <ToggleButton
                      active={feedbackStatus === '提交失败'}
                      label="保存失败"
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
  getRootProps,
  getInputProps,
  open,
}: {
  file: File | null;
  previewUrl: string | null;
  draft: ConversionDraft;
  isReading: boolean;
  isDragActive: boolean;
  getRootProps: ReturnType<typeof useDropzone>['getRootProps'];
  getInputProps: ReturnType<typeof useDropzone>['getInputProps'];
  open: () => void;
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
      <div className="overflow-hidden rounded-lg border-2 border-ink bg-ink">
        {previewUrl && file ? (
          isGif(file) ? (
            <img src={previewUrl} alt="" className="h-full min-h-52 w-full object-contain" />
          ) : (
            <video src={previewUrl} className="h-full min-h-52 w-full object-contain" muted={draft.muted} playsInline controls />
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
      </div>
    </section>
  );
}

function MediaPreview({ file, previewUrl, draft }: { file: File | null; previewUrl: string | null; draft: ConversionDraft }) {
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
    <section className="clay-card overflow-hidden bg-ink">
      {isGif(file) ? (
        <img src={previewUrl} alt="" className="h-full max-h-[520px] min-h-80 w-full object-contain" />
      ) : (
        <video
          src={previewUrl}
          className="h-full max-h-[520px] min-h-80 w-full object-contain"
          controls
          muted={draft.muted}
          playsInline
        />
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

function SavePathPanel({ presetId }: { presetId: ExportPresetId }) {
  const isLockScreen = presetId === 'ios-lock-screen';

  return (
    <section className="grid gap-3 md:grid-cols-2">
      <SavePathCard
        icon={<Smartphone size={20} />}
        title={isLockScreen ? 'iPhone 锁屏路径' : 'iPhone 相册路径'}
        text={
          isLockScreen
            ? 'Safari 下载 ZIP 后只会得到文件 App 素材包；要变成锁屏实况，还需云端元数据和真机导入路径验证。'
            : 'Safari 下载 ZIP 后通过文件 App 查看素材包；这一步不会自动写入 iOS 相册成为实况照片。'
        }
      />
      <SavePathCard
        icon={<MonitorDown size={20} />}
        title="桌面下载路径"
        text="下载 ZIP、关键帧和动态片段；后续用 AirDrop、Shortcuts 或容器云端包验证相册识别。"
      />
    </section>
  );
}

function SavePathCard({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <article className="clay-card flex gap-3 bg-white p-4">
      <span className="mt-0.5 shrink-0 text-[#23b7a4]">{icon}</span>
      <div>
        <p className="text-sm font-black text-ink">{title}</p>
        <p className="mt-1 text-sm font-semibold leading-6 text-ink/65">{text}</p>
      </div>
    </article>
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
        下载素材 ZIP
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
  onDownload,
  onDelete,
}: {
  job: CloudJob;
  downloadUrl: string | null;
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
  const activeDownloadUrl = canDownload ? downloadUrl : null;
  const qrDataUrl = qrPreview?.downloadUrl === activeDownloadUrl ? qrPreview.dataUrl : null;

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
    <Panel title="云端任务" icon={<CloudOff size={18} />}>
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
        <div className="mt-3 rounded-lg border-2 border-ink/15 bg-[#fff4df] p-3">
          <p className="text-xs font-black text-ink">实况识别说明</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-ink/65">
            云端 ZIP 是带元数据尝试的配对素材包；Safari 直接下载仍不会自动写入相册，需通过 AirDrop、Shortcuts 或真机导入路径复测。
          </p>
        </div>
      )}

      {job.error && (
        <div className="mt-3 rounded-lg border-2 border-ink bg-[#ffe2dc] p-3">
          <p className="text-xs font-black text-ink">{job.error.code}</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-ink/65">{job.error.message}</p>
        </div>
      )}

      {job.warnings.length > 0 && (
        <div className="mt-3 rounded-lg border-2 border-ink/15 bg-[#fff4df] p-3">
          <p className="text-xs font-black text-ink">兼容提示</p>
          <ul className="mt-2 grid gap-1 text-xs font-semibold leading-5 text-ink/65">
            {job.warnings.map((warning) => (
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

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!canDownload}
          onClick={() => {
            if (job.artifact) {
              onDownload(job.artifact.downloadUrl);
            }
          }}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-3 text-sm font-black text-white shadow-clay-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40"
        >
          <FileArchive size={16} />
          下载素材包
        </button>
        <button
          type="button"
          onClick={() => {
            void onDelete();
          }}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-white px-3 text-sm font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5"
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

function PresetButton({ active, presetId, onClick }: { active: boolean; presetId: ExportPresetId; onClick: () => void }) {
  const preset = exportPresets[presetId];

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-lg border-2 p-3 text-left transition hover:-translate-y-0.5',
        active ? 'border-ink bg-[#d9f99d] shadow-clay-sm' : 'border-ink/15 bg-white hover:border-ink',
      ].join(' ')}
    >
      <span className="block text-sm font-black">{preset.label}</span>
      <span className="mt-1 block text-xs leading-5 text-ink/65">{preset.target}</span>
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
  onClick,
}: {
  active: boolean;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-lg border-2 p-3 text-left transition hover:-translate-y-0.5',
        active ? 'border-ink bg-[#d9f99d] shadow-clay-sm' : 'border-ink/15 bg-white hover:border-ink',
      ].join(' ')}
    >
      <span className="flex items-center gap-2 text-sm font-black text-ink">
        {active && <CheckCircle2 size={15} className="text-[#23b7a4]" />}
        {label}
      </span>
      <span className="mt-1 block text-xs font-semibold text-ink/60">{description}</span>
    </button>
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
        className="w-full accent-[#ff715b]"
      />
    </label>
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

function ToolboxItem({ label, status }: { label: string; status: 'available' | 'preview' | 'planned' }) {
  const statusClass = {
    available: 'bg-[#d9f99d]',
    preview: 'bg-[#e4f7ff]',
    planned: 'bg-[#fff4df]',
  }[status];

  return (
    <div className="flex min-h-12 items-center justify-between gap-3 rounded-lg border-2 border-ink/15 bg-white p-3">
      <span className="text-sm font-black text-ink">{label}</span>
      <span className={`rounded-lg border border-ink/15 px-2 py-1 text-xs font-black text-ink/65 ${statusClass}`}>
        {status}
      </span>
    </div>
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
