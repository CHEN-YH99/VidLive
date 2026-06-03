'use client';

import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  Download,
  Film,
  ImageIcon,
  Lock,
  MessageSquareQuote,
  MonitorDown,
  Palette,
  PlayCircle,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
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

const catalogItems = [
  {
    icon: <Smartphone size={20} />,
    title: '锁屏壁纸班',
    text: '1-2 秒竖屏片段，关键帧居中，优先适配 iOS 17+ 锁屏。',
    tone: 'bg-[#ff715b]',
  },
  {
    icon: <Film size={20} />,
    title: 'Live Photo 基础班',
    text: '标准 MOV + 静态图组合，适合相册保存、分享和后续导入。',
    tone: 'bg-[#23b7a4]',
  },
  {
    icon: <Palette size={20} />,
    title: '社交兜底班',
    text: '导出 MP4 或 GIF，让无法识别 Live Photo 的场景也有结果。',
    tone: 'bg-[#f7c948]',
  },
  {
    icon: <Lock size={20} />,
    title: '隐私自习室',
    text: '小文件默认本地处理，云端处理必须先确认上传和删除规则。',
    tone: 'bg-[#6aa9ff]',
  },
];

const progressSteps = [
  { label: '解析素材', value: 100, color: 'bg-[#23b7a4]' },
  { label: '裁剪片段', value: 74, color: 'bg-[#f7c948]' },
  { label: '选择关键帧', value: 58, color: 'bg-[#ff715b]' },
  { label: '打包导出', value: 32, color: 'bg-[#6aa9ff]' },
];

const testimonials = [
  {
    name: '手机壁纸玩家',
    role: 'iPhone 用户',
    quote: '锁屏模式把参数都摆明了，失败时也知道该改哪里，不用自己乱猜。',
  },
  {
    name: '短视频剪辑师',
    role: '内容创作者',
    quote: '上传前就能看到本地处理提示，私人素材不会莫名其妙跑到服务器。',
  },
  {
    name: '活动运营',
    role: '设计协作',
    quote: '预设像课程目录一样清楚，新同事也能照着做出统一规格的素材。',
  },
];

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
    <main className="min-h-screen overflow-hidden bg-[#fff4df] text-ink">
      <section className="relative overflow-hidden border-b-4 border-ink/10">
        <img
          src="/images/vidlive-clay-hero.png"
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-[0.45]"
        />
        <div className="absolute inset-0 bg-[#fff4df]/75" />
        <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
          <header className="flex items-center justify-between gap-3">
            <div className="inline-flex h-11 items-center gap-2 rounded-lg border-2 border-ink bg-white px-3 font-semibold shadow-clay-sm">
              <Sparkles size={18} className="text-[#ff715b]" />
              VidLive
            </div>
            <nav className="hidden items-center gap-2 md:flex">
              <StatusPill icon={<ShieldCheck size={16} />} label="本地优先" tone="mint" />
              <StatusPill icon={<Film size={16} />} label="MP4 MOV GIF" tone="sky" />
              <StatusPill icon={<Clock3 size={16} />} label="1-2 秒锁屏" tone="sun" />
            </nav>
          </header>

          <div className="grid min-h-[calc(100vh-150px)] gap-5 pb-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,0.82fr)] lg:items-center">
            <div className="max-w-3xl py-6 lg:py-10">
              <p className="inline-flex items-center gap-2 rounded-lg border-2 border-ink bg-[#f7c948] px-3 py-2 text-sm font-bold shadow-clay-sm">
                <BookOpenCheck size={16} />
                Live Photo 创作小课堂
              </p>
              <h1 className="mt-5 max-w-3xl text-4xl font-black leading-tight text-ink sm:text-5xl lg:text-6xl">
                把短视频练成会动的 iPhone 锁屏素材
              </h1>
              <p className="mt-5 max-w-2xl text-base font-medium leading-8 text-ink/72 sm:text-lg">
                上传、裁剪、选关键帧、导出指引都放在一个轻快工作台里。小文件默认本地处理，云端能力只作为明确告知后的兜底。
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={open}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#ff715b] px-5 text-sm font-black text-white shadow-clay transition hover:-translate-y-0.5"
                >
                  <Upload size={18} />
                  选择素材
                </button>
                <a
                  href="#studio"
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-white px-5 text-sm font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5"
                >
                  打开工作台
                  <ArrowRight size={18} />
                </a>
              </div>
              <div className="mt-6 grid max-w-2xl grid-cols-3 gap-3">
                <HeroStat label="本地上限" value="100MB" />
                <HeroStat label="锁屏片段" value="1-2s" />
                <HeroStat label="导出组合" value="ZIP MOV" />
              </div>
            </div>

            <UploadHeroCard
              file={file}
              previewUrl={previewUrl}
              draft={draft}
              isDragActive={isDragActive}
              isReading={isReading}
              getRootProps={getRootProps}
              getInputProps={getInputProps}
              open={open}
            />
          </div>
        </div>
      </section>

      <section id="studio" className="bg-[#fff4df] py-8 sm:py-10">
        <div className="mx-auto grid w-full max-w-7xl gap-5 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_390px] lg:px-8">
          <div className="flex flex-col gap-4">
            <SectionHeading
              eyebrow="创作台"
              title="剪一段，选一帧，再交作业"
              text="这里保留 MVP 的核心路径：导入素材、查看信息、裁剪起止点、选择关键帧和导出预设。"
            />

            <div className="clay-card overflow-hidden bg-white">
              <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_210px]">
                <MediaPreview file={file} previewUrl={previewUrl} draft={draft} />
                <CoverPreview activeCoverUrl={activeCoverUrl} open={open} />
              </div>
            </div>

            {currentFailure && <FailureNotice reasonTitle={currentFailure.title} action={currentFailure.action} />}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="文件" value={metadata?.name ?? '未选择'} accent="coral" />
              <Metric label="大小" value={metadata ? formatBytes(metadata.sizeBytes) : '-'} accent="mint" />
              <Metric label="时长" value={metadata ? formatSeconds(metadata.durationSeconds) : '-'} accent="sun" />
              <Metric
                label="尺寸"
                value={metadata?.width && metadata.height ? `${metadata.width} x ${metadata.height}` : '-'}
                accent="sky"
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

            <Panel title="预设目录" icon={<Download size={18} />}>
              <div className="grid gap-2">
                {(Object.keys(exportPresets) as ExportPresetId[]).map((presetId) => {
                  const preset = exportPresets[presetId];

                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => updatePreset(preset.id)}
                      className={[
                        'rounded-lg border-2 p-3 text-left transition hover:-translate-y-0.5',
                        draft.presetId === preset.id
                          ? 'border-ink bg-[#d9f99d] shadow-clay-sm'
                          : 'border-ink/15 bg-white hover:border-ink',
                      ].join(' ')}
                    >
                      <span className="block text-sm font-black">{preset.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-ink/65">{preset.target}</span>
                    </button>
                  );
                })}
              </div>
            </Panel>

            <Panel title="时间轴练习" icon={<Scissors size={18} />}>
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

            <Panel title="画面作业" icon={<SlidersHorizontal size={18} />}>
              <div className="grid grid-cols-3 gap-2">
                {aspectRatios.map((ratio) => (
                  <button
                    key={ratio.id}
                    type="button"
                    onClick={() => setDraft((current) => ({ ...current, aspectRatioId: ratio.id }))}
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
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border-2 border-ink/15 bg-white text-sm font-black text-ink transition hover:border-ink"
              >
                {draft.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                {draft.muted ? '静音' : '保留声音'}
              </button>
            </Panel>

            <button
              type="button"
              disabled={!canGenerate}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#23b7a4] px-4 text-sm font-black text-white shadow-clay transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:bg-ink/20 disabled:text-ink/40"
            >
              <Download size={17} />
              生成文件
            </button>
          </aside>
        </div>
      </section>

      <CatalogSection />
      <ProgressSection />
      <TestimonialsSection />
      <EnrollmentCTA open={open} />
    </main>
  );
}

function UploadHeroCard({
  file,
  previewUrl,
  draft,
  isDragActive,
  isReading,
  getRootProps,
  getInputProps,
  open,
}: {
  file: File | null;
  previewUrl: string | null;
  draft: ConversionDraft;
  isDragActive: boolean;
  isReading: boolean;
  getRootProps: ReturnType<typeof useDropzone>['getRootProps'];
  getInputProps: ReturnType<typeof useDropzone>['getInputProps'];
  open: () => void;
}) {
  return (
    <div className="clay-card bg-white/90 p-4">
      <div
        {...getRootProps()}
        className={[
          'flex min-h-[360px] flex-col justify-between rounded-lg border-2 border-dashed p-4 transition',
          isDragActive ? 'border-ink bg-[#d9f99d]' : 'border-ink/25 bg-[#fffaf0]',
        ].join(' ')}
      >
        <input {...getInputProps()} />
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 rounded-lg border-2 border-ink bg-[#6aa9ff] px-3 py-2 text-xs font-black text-white shadow-clay-sm">
            <PlayCircle size={15} />
            创作入口
          </span>
          <span className="rounded-lg border-2 border-ink bg-white px-3 py-2 text-xs font-black text-ink shadow-clay-sm">
            {draft.mode === 'local' ? '本地模式' : '云端确认'}
          </span>
        </div>

        <div className="my-4 overflow-hidden rounded-lg border-2 border-ink bg-ink">
          {previewUrl && file ? (
            isGif(file) ? (
              <img src={previewUrl} alt="" className="h-56 w-full object-contain" />
            ) : (
              <video src={previewUrl} className="h-56 w-full object-contain" muted={draft.muted} playsInline controls />
            )
          ) : (
            <div className="flex h-56 flex-col items-center justify-center gap-3 bg-[#e4f7ff] text-center text-ink">
              <div className="flex size-16 items-center justify-center rounded-lg border-2 border-ink bg-white shadow-clay-sm">
                <Upload size={30} className="text-[#ff715b]" />
              </div>
              <div>
                <p className="text-lg font-black">拖入视频或 GIF</p>
                <p className="mt-1 text-sm font-semibold text-ink/65">MP4、MOV、GIF，云端上限 500MB</p>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="flex items-center gap-2 text-sm font-bold text-ink/70">
            <BadgeCheck size={17} className="text-[#23b7a4]" />
            {isReading ? '正在读取素材信息' : '小文件不会上传服务器'}
          </div>
          <button
            type="button"
            onClick={open}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#f7c948] px-4 text-sm font-black text-ink shadow-clay-sm transition hover:-translate-y-0.5"
          >
            <Upload size={16} />
            选择文件
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <div className="max-w-3xl">
      <p className="text-sm font-black uppercase text-[#ff715b]">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-black text-ink sm:text-3xl">{title}</h2>
      <p className="mt-3 text-sm font-medium leading-7 text-ink/68 sm:text-base">{text}</p>
    </div>
  );
}

function MediaPreview({ file, previewUrl, draft }: { file: File | null; previewUrl: string | null; draft: ConversionDraft }) {
  if (!previewUrl || !file) {
    return (
      <div className="flex min-h-80 items-center justify-center rounded-lg border-2 border-ink bg-[#e4f7ff] text-ink/60">
        <div className="text-center">
          <Film size={34} className="mx-auto text-[#6aa9ff]" />
          <p className="mt-3 text-sm font-black">素材预览</p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border-2 border-ink bg-ink">
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
    </div>
  );
}

function CoverPreview({ activeCoverUrl, open }: { activeCoverUrl: string | null; open: () => void }) {
  return (
    <div className="grid gap-3">
      <div className="rounded-lg border-2 border-ink bg-[#fff4df] p-3">
        <p className="mb-2 text-sm font-black text-ink">封面帧</p>
        <div className="aspect-[9/16] w-full overflow-hidden rounded-lg border-2 border-ink/15 bg-white">
          {activeCoverUrl ? (
            <img src={activeCoverUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full min-h-36 items-center justify-center text-ink/50">
              <ImageIcon size={24} />
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
    </div>
  );
}

function FailureNotice({ reasonTitle, action }: { reasonTitle: string; action: string }) {
  return (
    <div className="flex gap-3 rounded-lg border-2 border-ink bg-[#ffe2dc] p-4 text-sm shadow-clay-sm">
      <AlertTriangle className="mt-0.5 shrink-0 text-[#ff715b]" size={18} />
      <div>
        <p className="font-black text-ink">{reasonTitle}</p>
        <p className="mt-1 font-medium text-ink/65">{action}</p>
      </div>
    </div>
  );
}

function CatalogSection() {
  return (
    <section className="bg-[#e4f7ff] py-10 sm:py-14">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="预设目录"
          title="像选课一样选择导出路线"
          text="不是把 VidLive 改成课程站，而是把复杂参数变成清楚的目录卡片，让用户知道自己正在选什么。"
        />
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {catalogItems.map((item) => (
            <article key={item.title} className="clay-card bg-white p-4">
              <div className={`mb-4 flex size-11 items-center justify-center rounded-lg border-2 border-ink text-white ${item.tone}`}>
                {item.icon}
              </div>
              <h3 className="text-lg font-black text-ink">{item.title}</h3>
              <p className="mt-3 text-sm font-semibold leading-6 text-ink/64">{item.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProgressSection() {
  return (
    <section className="bg-[#fff4df] py-10 sm:py-14">
      <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-[0.8fr_1fr] lg:items-center lg:px-8">
        <SectionHeading
          eyebrow="进度演示"
          title="把转换过程做成看得懂的进度条"
          text="解析、裁剪、关键帧和打包都拆成阶段，让失败提示能落到具体步骤，不再只甩一句生成失败。"
        />
        <div className="clay-card bg-white p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black text-[#23b7a4]">本地处理演示</p>
              <h3 className="mt-1 text-xl font-black text-ink">锁屏壁纸作业进度</h3>
            </div>
            <div className="flex size-12 items-center justify-center rounded-lg border-2 border-ink bg-[#f7c948] shadow-clay-sm">
              <Wand2 size={22} />
            </div>
          </div>
          <div className="grid gap-4">
            {progressSteps.map((step) => (
              <div key={step.label}>
                <div className="mb-2 flex items-center justify-between text-sm font-black text-ink">
                  <span>{step.label}</span>
                  <span>{step.value}%</span>
                </div>
                <div className="h-4 overflow-hidden rounded-lg border-2 border-ink bg-[#fff4df]">
                  <div className={`h-full rounded-md ${step.color}`} style={{ width: `${step.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TestimonialsSection() {
  return (
    <section className="bg-[#d9f99d] py-10 sm:py-14">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="用户反馈"
          title="让用户像交作业一样完成导出"
          text="评价区沿用教育平台的亲切语气，但内容仍然围绕 Live Photo、锁屏、隐私和保存路径。"
        />
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          {testimonials.map((item) => (
            <article key={item.name} className="clay-card bg-white p-5">
              <MessageSquareQuote size={24} className="text-[#ff715b]" />
              <p className="mt-4 text-base font-bold leading-7 text-ink">“{item.quote}”</p>
              <div className="mt-5 border-t-2 border-dashed border-ink/15 pt-4">
                <p className="font-black text-ink">{item.name}</p>
                <p className="text-sm font-semibold text-ink/55">{item.role}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function EnrollmentCTA({ open }: { open: () => void }) {
  return (
    <section className="bg-[#ff715b] py-10 sm:py-14">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-start justify-between gap-5 px-4 sm:px-6 lg:flex-row lg:items-center lg:px-8">
        <div className="max-w-2xl text-white">
          <p className="text-sm font-black uppercase">开始制作</p>
          <h2 className="mt-2 text-3xl font-black leading-tight sm:text-4xl">开一节自己的 Live Photo 小课</h2>
          <p className="mt-3 text-base font-semibold leading-7 text-white/82">
            拿一个短视频开始，先跑通裁剪和关键帧，再去验证 iPhone 保存路径。别上来就 AI、账号、支付全家桶，醒醒。
          </p>
        </div>
        <button
          type="button"
          onClick={open}
          className="inline-flex h-12 min-w-44 items-center justify-center gap-2 rounded-lg border-2 border-ink bg-[#f7c948] px-5 text-sm font-black text-ink shadow-clay transition hover:-translate-y-0.5"
        >
          <Upload size={18} />
          开始制作
        </button>
      </div>
    </section>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border-2 border-ink bg-white px-3 py-3 shadow-clay-sm">
      <p className="text-xs font-black text-ink/50">{label}</p>
      <p className="mt-1 text-lg font-black text-ink">{value}</p>
    </div>
  );
}

function StatusPill({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'mint' | 'sky' | 'sun';
}) {
  const toneClass = {
    mint: 'bg-[#d9f99d]',
    sky: 'bg-[#e4f7ff]',
    sun: 'bg-[#f7c948]',
  }[tone];

  return (
    <div
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border-2 border-ink px-3 text-sm font-black text-ink shadow-clay-sm ${toneClass}`}
    >
      {icon}
      {label}
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
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

function Metric({ label, value, accent }: { label: string; value: string; accent: 'coral' | 'mint' | 'sun' | 'sky' }) {
  const accentClass = {
    coral: 'bg-[#ff715b]',
    mint: 'bg-[#23b7a4]',
    sun: 'bg-[#f7c948]',
    sky: 'bg-[#6aa9ff]',
  }[accent];

  return (
    <div className="clay-card min-h-24 bg-white p-4">
      <span className={`mb-3 block h-2 w-12 rounded-lg border border-ink/20 ${accentClass}`} />
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

function GuidancePanel({ presetId }: { presetId: ExportPresetId }) {
  const isLockScreen = presetId === 'ios-lock-screen';

  return (
    <section className="grid gap-3 md:grid-cols-2">
      <div className="clay-card flex gap-3 bg-white p-4">
        <Smartphone className="mt-0.5 shrink-0 text-[#23b7a4]" size={20} />
        <div>
          <p className="text-sm font-black text-ink">手机保存路径</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-ink/65">
            {isLockScreen
              ? '下载后导入相册，再在锁屏壁纸中选择 Live Photo。'
              : '下载 Live Photo 文件组合后，通过相册或 Shortcuts 完成保存。'}
          </p>
        </div>
      </div>
      <div className="clay-card flex gap-3 bg-white p-4">
        <MonitorDown className="mt-0.5 shrink-0 text-[#f7c948]" size={20} />
        <div>
          <p className="text-sm font-black text-ink">桌面保存路径</p>
          <p className="mt-1 text-sm font-semibold leading-6 text-ink/65">
            下载 ZIP、MOV 或 MP4，再通过 AirDrop、二维码或数据线发送到 iPhone。
          </p>
        </div>
      </div>
    </section>
  );
}
