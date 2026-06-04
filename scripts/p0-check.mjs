/* global console, process */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_ORDER = {
  pass: 0,
  blocked: 1,
};

const STATUS_LABEL = {
  pass: 'PASS',
  blocked: 'BLOCKED',
};

const sourceFiles = {
  shared: 'packages/shared/src/index.ts',
  webTool: 'apps/web/components/vidlive-tool.tsx',
  localExport: 'apps/web/lib/local-export.ts',
  fileInspector: 'apps/web/lib/file-inspector.ts',
  phase0Routes: 'apps/api/src/modules/phase0/phase0.routes.ts',
  livePhotoService: 'apps/api/src/services/live-photo/live-photo.service.ts',
  privacyCheck: 'scripts/privacy-check.mjs',
  record: 'P0必做清单记录.md',
};

const p0Definitions = [
  {
    id: 'live-photo-generation-save-path',
    title: 'Live Photo 生成和保存路径验证',
    autoChecks: [
      {
        title: 'Phase 0 POC 可生成 Live Photo 相关产物',
        sources: ['phase0Routes', 'livePhotoService'],
        snippets: ['LivePhotoService', 'photo.jpg', 'video.mov', 'createStoreZip'],
      },
      {
        title: '保存路径覆盖 Shortcuts、AirDrop、ZIP',
        sources: ['shared', 'localExport', 'webTool'],
        snippets: ['Shortcuts', 'AirDrop', '桌面 ZIP 下载', '素材 ZIP'],
      },
    ],
    manualChecks: ['真机保存路径跑通', '失败路径记录'],
  },
  {
    id: 'ios-lock-screen-preset',
    title: 'iOS 锁屏壁纸预设验证',
    autoChecks: [
      {
        title: '锁屏预设参数已覆盖',
        sources: ['shared', 'webTool'],
        snippets: ["'ios-lock-screen'", 'defaultDurationSeconds: 2', 'preferredAspectRatio: \'9:16\'', 'preferredFps: 60'],
      },
      {
        title: '锁屏路径和失败提示已覆盖',
        sources: ['shared', 'webTool'],
        snippets: ['iPhone 锁屏路径', 'lock-screen-not-playing', '锁屏播放有真机记录'],
      },
    ],
    manualChecks: ['iOS 17+ 锁屏播放记录', '锁屏失败条件记录'],
  },
  {
    id: 'local-import-metadata',
    title: '本地素材导入和元信息解析',
    autoChecks: [
      {
        title: 'MP4/MOV/GIF 导入入口已覆盖',
        sources: ['shared', 'webTool', 'fileInspector'],
        snippets: ['supportedInputs', 'useDropzone', 'isSupportedInput'],
      },
      {
        title: '视频和 GIF 元信息解析已覆盖',
        sources: ['fileInspector', 'webTool'],
        snippets: ['inspectVideoFile', 'inspectImageLikeFile', 'VideoMetadata', 'formatBytes'],
      },
    ],
    manualChecks: ['桌面导入样例', '移动端导入样例'],
  },
  {
    id: 'timeline-trim',
    title: '时间轴裁剪',
    autoChecks: [
      {
        title: '起点和终点控件已覆盖',
        sources: ['webTool'],
        snippets: ['updateStart', 'updateEnd', 'RangeField', '当前片段'],
      },
      {
        title: '裁剪边界约束已覆盖',
        sources: ['webTool', 'localExport'],
        snippets: ['productLimits.minDurationSeconds', 'clamp(', 'draft.startSeconds', 'draft.endSeconds'],
      },
    ],
    manualChecks: ['裁剪操作记录', '边界裁剪记录'],
  },
  {
    id: 'manual-keyframe',
    title: '手动关键帧选择',
    autoChecks: [
      {
        title: '关键帧控件和状态已覆盖',
        sources: ['webTool'],
        snippets: ['updateKeyframe', 'keyframeSeconds', '关键帧'],
      },
      {
        title: '封面抓帧和预览已覆盖',
        sources: ['fileInspector', 'webTool'],
        snippets: ['captureCoverFrame', 'CoverPreview', '关键帧预览'],
      },
    ],
    manualChecks: ['关键帧选择样例', '封面预览样例'],
  },
  {
    id: 'standard-lock-presets',
    title: '标准预设和锁屏预设',
    autoChecks: [
      {
        title: '标准和锁屏预设定义已覆盖',
        sources: ['shared'],
        snippets: ["'standard-live-photo'", "'ios-lock-screen'", "outputs: ['zip', 'mov', 'jpeg', 'mp4'", "'webp'"],
      },
      {
        title: '预设选择 UI 已覆盖',
        sources: ['webTool'],
        snippets: ['PresetButton', '导出预设', 'updatePreset'],
      },
    ],
    manualChecks: ['标准预设导出样例', '锁屏预设导出样例'],
  },
  {
    id: 'export-preview-download',
    title: '导出结果预览和下载',
    autoChecks: [
      {
        title: '导出结果预览已覆盖',
        sources: ['webTool'],
        snippets: ['ExportResultPanel', 'aria-label="导出结果预览"', 'resultPreviewUrl'],
      },
      {
        title: 'ZIP 和 artifact 下载已覆盖',
        sources: ['webTool', 'localExport'],
        snippets: ['downloadBlob', '素材 ZIP', 'packageArtifact'],
      },
    ],
    manualChecks: ['导出结果预览记录', 'ZIP 和 artifact 下载记录'],
  },
  {
    id: 'save-setting-guidance',
    title: '保存/设置指引',
    autoChecks: [
      {
        title: 'iPhone 相册和锁屏路径已覆盖',
        sources: ['webTool', 'localExport'],
        snippets: ['SavePathPanel', 'iPhone 相册路径', 'iPhone 锁屏路径'],
      },
      {
        title: '桌面和 AirDrop/Shortcuts 指引已覆盖',
        sources: ['webTool', 'localExport'],
        snippets: ['桌面下载路径', 'AirDrop', 'Shortcuts'],
      },
    ],
    manualChecks: ['保存指引实操记录', '锁屏设置实操记录'],
  },
  {
    id: 'privacy-failure-handling',
    title: '隐私提示和失败处理',
    autoChecks: [
      {
        title: '隐私提示和云端确认已覆盖',
        sources: ['webTool', 'privacyCheck'],
        snippets: ['素材不离开浏览器', 'cloudConsentConfirmed', 'local-original-no-upload'],
      },
      {
        title: '失败原因和提示组件已覆盖',
        sources: ['shared', 'webTool'],
        snippets: ['failureAdvice', 'FailureNotice', 'file-too-large', 'unsupported-format'],
      },
    ],
    manualChecks: ['隐私抓包记录', '失败路径记录'],
  },
];

export async function collectP0Checks(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, 'P0 必做清单手动验收状态');

  return p0Definitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => evaluateAutoCheck(check, sources));
    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed ? 'P0 必做清单手动验收记录已标记通过。' : '需要补齐真实操作、真机或抓包证据后再标记通过。',
    }));
    const checks = [...autoResults, ...manualResults];
    const status = worstStatus(checks.map((check) => check.status));

    return {
      id: definition.id,
      title: definition.title,
      status,
      autoResults,
      manualResults,
    };
  });
}

export function summarizeP0Checks(items) {
  return items.reduce(
    (summary, item) => {
      summary[item.status] += 1;
      summary.worstStatus =
        STATUS_ORDER[item.status] > STATUS_ORDER[summary.worstStatus] ? item.status : summary.worstStatus;
      return summary;
    },
    { pass: 0, blocked: 0, worstStatus: 'pass' },
  );
}

export function formatP0Report(items) {
  const summary = summarizeP0Checks(items);
  const lines = ['VidLive P0 Checklist', `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`, ''];

  for (const item of items) {
    lines.push(`[${STATUS_LABEL[item.status]}] ${item.id} - ${item.title}`);
    lines.push(`  自动检查：${formatCheckSummary(item.autoResults)}`);
    lines.push(`  手动证据：${formatCheckSummary(item.manualResults)}`);
  }

  return lines.join('\n');
}

function evaluateAutoCheck(check, sources) {
  const source = joinSources(sources, check.sources);
  const missing = (check.snippets ?? []).filter((snippet) => !source.includes(snippet));

  if (missing.length === 0) {
    return {
      title: check.title,
      status: 'pass',
      detail: 'P0 实现片段已覆盖。',
    };
  }

  return {
    title: check.title,
    status: 'blocked',
    detail: `缺少实现片段：${missing.join(', ')}`,
  };
}

async function readSources(root) {
  const entries = await Promise.all(
    Object.entries(sourceFiles).map(async ([key, relativePath]) => [key, await readOptional(root, relativePath)]),
  );

  return Object.fromEntries(entries);
}

function joinSources(sources, keys) {
  return keys.map((key) => sources[key] ?? '').join('\n');
}

function worstStatus(statuses) {
  return statuses.reduce((worst, status) => {
    return STATUS_ORDER[status] > STATUS_ORDER[worst] ? status : worst;
  }, 'pass');
}

function formatCheckSummary(checks) {
  const pass = checks.filter((check) => check.status === 'pass').length;
  const blocked = checks.length - pass;

  return `PASS ${pass}, BLOCKED ${blocked}`;
}

function hasManualPassMarker(content, label) {
  const searchableContent = stripFencedCodeBlocks(content);
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markerPattern = new RegExp(`(?:^|\\n)>?\\s*\\*\\*${escapedLabel}\\*\\*：通过\\s*(?:\\r?\\n|$)`);

  return markerPattern.test(searchableContent);
}

function stripFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, '');
}

async function readOptional(root, relativePath) {
  try {
    return await readFile(path.join(root, relativePath), 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const strict = process.argv.includes('--strict');
  const items = await collectP0Checks({ root: process.cwd() });
  const summary = summarizeP0Checks(items);

  console.log(formatP0Report(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
