'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  ImageIcon,
  MonitorDown,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type FileRejection, useDropzone } from 'react-dropzone';
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

const initialPreset = exportPresets['ios-lock-screen'];

const initialDraft: ConversionDraft = {
  mode: 'local',
  presetId: initialPreset.id,
  aspectRatioId: initialPreset.preferredAspectRatio,
  fitMode: 'cover',
  startSeconds: 0,
  endSeconds: initialPreset.defaultDurationSeconds,
  keyframeSeconds: initialPreset.defaultDurationSeconds / 2,
  muted: true,
};

function isGif(file: File): boolean {
  return file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
}

function getDropError(rejections: FileRejection[]): FailureReason | null {
  const first = rejections[0];
  const firstError = first?.errors[0];

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
  const startSeconds = 0;
  const endSeconds = Math.max(clipDuration, productLimits.minDurationSeconds);
  const keyframeSeconds = startSeconds + (endSeconds - startSeconds) / 2;

  return {
    ...previous,
    presetId,
    aspectRatioId: preset.preferredAspectRatio,
    startSeconds,
    endSeconds,
    keyframeSeconds,
  };
}

export function VidLiveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [draft, setDraft] = useState<ConversionDraft>(initialDraft);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [failureReason, setFailureReason] = useState<FailureReason | null>(null);
  const [isReading, setIsReading] = useState(false);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

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

  const handleDrop = useCallback(async (acceptedFiles: File[], rejections: FileRejection[]) => {
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

    const objectUrl = URL.createObjectURL(selectedFile);

    try {
      const nextMetadata = isGif(selectedFile)
        ? inspectImageLikeFile(selectedFile)
        : await inspectVideoFile(selectedFile, objectUrl);
      const shouldUseCloud = selectedFile.size > productLimits.localFileSizeBytes;
      const presetId = shouldUseCloud ? 'standard-live-photo' : draft.presetId;

      setFile(selectedFile);
      setMetadata(nextMetadata);
      setPreviewUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return objectUrl;
      });
      setDraft((current) => ({
        ...getDefaultDraftForPreset(presetId, current, nextMetadata),
        mode: shouldUseCloud ? 'cloud' : 'local',
      }));
    } catch {
      URL.revokeObjectURL(objectUrl);
      setFailureReason('metadata-read-failed');
    } finally {
      setIsReading(false);
    }
  }, [draft.presetId]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: acceptedMimeTypes,
    maxSize: productLimits.cloudFileSizeBytes,
    multiple: false,
    noClick: true,
    noKeyboard: true,
    onDrop: handleDrop,
  });

  const selectedPreset = exportPresets[draft.presetId];
  const durationMax = metadata?.durationSeconds ?? Math.max(draft.endSeconds, selectedPreset.defaultDurationSeconds);
  const currentFailure = failureReason ? failureAdvice[failureReason] : null;
  const canGenerate = Boolean(file && metadata);
  const activeCoverUrl = file && !isGif(file) ? coverUrl : null;

  const updatePreset = (presetId: ExportPresetId) => {
    setDraft((current) => getDefaultDraftForPreset(presetId, current, metadata));
  };

  const updateStart = (value: number) => {
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
    setDraft((current) => ({
      ...current,
      keyframeSeconds: clamp(value, current.startSeconds, current.endSeconds),
    }));
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 border-b border-ink/10 pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold text-mint">VidLive</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink sm:text-3xl">Live Photo 工作台</h1>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:flex">
          <StatusPill icon={<ShieldCheck size={16} />} label="本地优先" tone="mint" />
          <StatusPill icon={<Film size={16} />} label="MP4 MOV GIF" tone="ink" />
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-4">
          <div
            {...getRootProps()}
            className={[
              'min-h-[260px] rounded-lg border border-dashed bg-white p-4 shadow-panel transition',
              isDragActive ? 'border-mint bg-emerald-50' : 'border-ink/20',
            ].join(' ')}
          >
            <input {...getInputProps()} />
            {previewUrl && file ? (
              <div className="grid h-full gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                <div className="overflow-hidden rounded-lg border border-ink/10 bg-black">
                  {isGif(file) ? (
                    <img src={previewUrl} alt="" className="h-full max-h-[520px] w-full object-contain" />
                  ) : (
                    <video
                      src={previewUrl}
                      className="h-full max-h-[520px] w-full object-contain"
                      controls
                      muted={draft.muted}
                      playsInline
                    />
                  )}
                </div>
                <div className="grid gap-3">
                  <PreviewTile title="封面帧">
                    {activeCoverUrl ? (
                      <img src={activeCoverUrl} alt="" className="h-full w-full rounded-md object-cover" />
                    ) : (
                      <div className="flex h-full min-h-36 items-center justify-center rounded-md bg-surface text-ink/60">
                        <ImageIcon size={24} />
                      </div>
                    )}
                  </PreviewTile>
                  <button
                    type="button"
                    onClick={open}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white transition hover:bg-ink/90"
                  >
                    <Upload size={16} />
                    更换素材
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[230px] flex-col items-center justify-center gap-4 text-center">
                <div className="flex size-14 items-center justify-center rounded-lg bg-mint/10 text-mint">
                  <Upload size={28} />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-ink">选择一个短视频或 GIF</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-ink/65">
                    本地模式建议 100MB 内，超过后进入云端确认流程。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={open}
                  className="inline-flex h-11 min-w-40 items-center justify-center gap-2 rounded-md bg-mint px-4 text-sm font-semibold text-white transition hover:bg-mint/90"
                >
                  <Upload size={16} />
                  选择文件
                </button>
                {isReading && <p className="text-sm text-ink/60">正在读取素材信息</p>}
              </div>
            )}
          </div>

          {currentFailure && (
            <div className="flex gap-3 rounded-lg border border-coral/30 bg-white p-4 text-sm shadow-panel">
              <AlertTriangle className="mt-0.5 shrink-0 text-coral" size={18} />
              <div>
                <p className="font-semibold text-ink">{currentFailure.title}</p>
                <p className="mt-1 text-ink/65">{currentFailure.action}</p>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="文件" value={metadata?.name ?? '未选择'} />
            <Metric label="大小" value={metadata ? formatBytes(metadata.sizeBytes) : '-'} />
            <Metric label="时长" value={metadata ? formatSeconds(metadata.durationSeconds) : '-'} />
            <Metric
              label="尺寸"
              value={metadata?.width && metadata.height ? `${metadata.width} x ${metadata.height}` : '-'}
            />
          </div>

          <GuidancePanel presetId={draft.presetId} />
        </div>

        <aside className="flex flex-col gap-4">
          <Panel title="处理模式" icon={<ShieldCheck size={18} />}>
            <div className="grid grid-cols-2 gap-2">
              <ModeButton
                active={draft.mode === 'local'}
                label="本地"
                description="素材不上传"
                onClick={() => setDraft((current) => ({ ...current, mode: 'local' }))}
              />
              <ModeButton
                active={draft.mode === 'cloud'}
                label="云端"
                description="需确认上传"
                onClick={() => setDraft((current) => ({ ...current, mode: 'cloud' }))}
              />
            </div>
          </Panel>

          <Panel title="导出预设" icon={<Download size={18} />}>
            <div className="grid gap-2">
              {(Object.keys(exportPresets) as ExportPresetId[]).map((presetId) => {
                const preset = exportPresets[presetId];

                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => updatePreset(preset.id)}
                    className={[
                      'rounded-md border p-3 text-left transition',
                      draft.presetId === preset.id
                        ? 'border-mint bg-mint/10 text-ink'
                        : 'border-ink/10 bg-white hover:border-ink/30',
                    ].join(' ')}
                  >
                    <span className="block text-sm font-semibold">{preset.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-ink/60">{preset.target}</span>
                  </button>
                );
              })}
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
          </Panel>

          <Panel title="画面" icon={<SlidersHorizontal size={18} />}>
            <div className="grid grid-cols-3 gap-2">
              {aspectRatios.map((ratio) => (
                <button
                  key={ratio.id}
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, aspectRatioId: ratio.id }))}
                  className={[
                    'h-10 rounded-md border px-2 text-sm font-medium transition',
                    draft.aspectRatioId === ratio.id
                      ? 'border-mint bg-mint/10 text-mint'
                      : 'border-ink/10 bg-white text-ink/70 hover:border-ink/30',
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
                onClick={() => setDraft((current) => ({ ...current, fitMode: 'cover' as FitMode }))}
              />
              <ToggleButton
                active={draft.fitMode === 'contain'}
                label="补背景"
                onClick={() => setDraft((current) => ({ ...current, fitMode: 'contain' as FitMode }))}
              />
            </div>
            <button
              type="button"
              onClick={() => setDraft((current) => ({ ...current, muted: !current.muted }))}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-ink/10 bg-white text-sm font-medium text-ink transition hover:border-ink/30"
            >
              {draft.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
              {draft.muted ? '静音' : '保留声音'}
            </button>
          </Panel>

          <button
            type="button"
            disabled={!canGenerate}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-coral px-4 text-sm font-semibold text-white transition hover:bg-coral/90 disabled:cursor-not-allowed disabled:bg-ink/20"
          >
            <Download size={17} />
            生成文件
          </button>
        </aside>
      </section>
    </main>
  );
}

function StatusPill({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'mint' | 'ink';
}) {
  return (
    <div
      className={[
        'inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium',
        tone === 'mint' ? 'border-mint/20 bg-mint/10 text-mint' : 'border-ink/10 bg-white text-ink/70',
      ].join(' ')}
    >
      {icon}
      {label}
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-ink/10 bg-white p-4 shadow-panel">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="text-mint">{icon}</span>
        {title}
      </div>
      {children}
    </section>
  );
}

function PreviewTile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink/10 bg-white p-3">
      <p className="mb-2 text-sm font-semibold text-ink">{title}</p>
      <div className="aspect-[9/16] w-full overflow-hidden rounded-md">{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-20 rounded-lg border border-ink/10 bg-white p-4 shadow-panel">
      <p className="text-xs font-semibold uppercase text-ink/45">{label}</p>
      <p className="mt-2 break-words text-sm font-semibold text-ink">{value}</p>
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
        'rounded-md border p-3 text-left transition',
        active ? 'border-mint bg-mint/10' : 'border-ink/10 bg-white hover:border-ink/30',
      ].join(' ')}
    >
      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
        {active && <CheckCircle2 size={15} className="text-mint" />}
        {label}
      </span>
      <span className="mt-1 block text-xs text-ink/60">{description}</span>
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
      <span className="mb-2 flex items-center justify-between gap-3 text-sm text-ink/70">
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
        className="w-full accent-mint"
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
        'h-10 rounded-md border px-2 text-sm font-medium transition',
        active ? 'border-mint bg-mint/10 text-mint' : 'border-ink/10 bg-white text-ink/70 hover:border-ink/30',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function GuidancePanel({ presetId }: { presetId: ExportPresetId }) {
  const isLockScreen = presetId === 'ios-lock-screen';

  return (
    <section className="grid gap-3 rounded-lg border border-ink/10 bg-white p-4 shadow-panel md:grid-cols-2">
      <div className="flex gap-3">
        <Smartphone className="mt-0.5 shrink-0 text-mint" size={19} />
        <div>
          <p className="text-sm font-semibold text-ink">手机保存路径</p>
          <p className="mt-1 text-sm leading-6 text-ink/65">
            {isLockScreen
              ? '下载后导入相册，再在锁屏壁纸中选择 Live Photo。'
              : '下载 Live Photo 文件组合后，通过相册或 Shortcuts 完成保存。'}
          </p>
        </div>
      </div>
      <div className="flex gap-3">
        <MonitorDown className="mt-0.5 shrink-0 text-sun" size={19} />
        <div>
          <p className="text-sm font-semibold text-ink">桌面保存路径</p>
          <p className="mt-1 text-sm leading-6 text-ink/65">
            下载 ZIP、MOV 或 MP4，再通过 AirDrop、二维码或数据线发送到 iPhone。
          </p>
        </div>
      </div>
    </section>
  );
}
