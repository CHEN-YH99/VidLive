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
  localExport: 'apps/web/lib/local-export.ts',
  webTool: 'apps/web/components/vidlive-tool.tsx',
  phase0Routes: 'apps/api/src/modules/phase0/phase0.routes.ts',
  livePhotoService: 'apps/api/src/services/live-photo/live-photo.service.ts',
  record: '兼容测试矩阵记录.md',
};

const matrixDefinitions = [
  {
    id: 'iphone-safari',
    platform: 'iPhone Safari',
    requirement: '导入、裁剪、导出、保存指引、锁屏设置',
    autoChecks: [
      {
        title: '兼容矩阵声明 iPhone Safari',
        sources: ['shared'],
        snippets: ["id: 'iphone-safari'", "environment: 'iPhone Safari'"],
      },
      {
        title: '移动端导入、裁剪、导出和保存路径入口',
        sources: ['webTool', 'localExport'],
        snippets: ['UploadPanel', 'RangeField', 'handleGenerate', 'iPhone Safari', '锁屏路径'],
      },
    ],
    manualChecks: ['iPhone Safari 导入', 'iPhone Safari 裁剪', 'iPhone Safari 导出', '保存指引', '锁屏设置'],
  },
  {
    id: 'macos-safari',
    platform: 'macOS Safari',
    requirement: '导入、导出、下载 ZIP、AirDrop 路径',
    autoChecks: [
      {
        title: '兼容矩阵声明 macOS Safari',
        sources: ['shared'],
        snippets: ["id: 'macos-safari'", "environment: 'macOS Safari'"],
      },
      {
        title: '桌面 ZIP 下载和 AirDrop 指引',
        sources: ['webTool', 'localExport'],
        snippets: ['桌面下载路径', '下载 ZIP 包', 'AirDrop', 'application/zip'],
      },
    ],
    manualChecks: ['macOS Safari 导入', 'macOS Safari 导出', '下载 ZIP', 'AirDrop 路径'],
  },
  {
    id: 'chrome-desktop',
    platform: 'Chrome 桌面',
    requirement: '本地处理、MP4/GIF 导出',
    autoChecks: [
      {
        title: '兼容矩阵声明 Chrome Desktop',
        sources: ['shared'],
        snippets: ["id: 'chrome-desktop'", "environment: 'Chrome Desktop'"],
      },
      {
        title: '本地处理和 MP4/GIF 兜底导出',
        sources: ['shared', 'localExport', 'webTool'],
        snippets: ['generateLocalExport', 'MediaRecorder', "outputs: ['mp4', 'gif']", 'downloadBlob'],
      },
    ],
    manualChecks: ['Chrome 桌面本地处理', 'Chrome 桌面 MP4 导出', 'Chrome 桌面 GIF 导出'],
  },
  {
    id: 'edge-desktop',
    platform: 'Edge 桌面',
    requirement: '本地处理、下载行为',
    autoChecks: [
      {
        title: '兼容矩阵声明 Edge Desktop',
        sources: ['shared'],
        snippets: ["id: 'edge-desktop'", "environment: 'Edge Desktop'"],
      },
      {
        title: '本地处理和下载行为入口',
        sources: ['localExport', 'webTool'],
        snippets: ['generateLocalExport', 'downloadBlob', 'link.download', '桌面下载路径'],
      },
    ],
    manualChecks: ['Edge 桌面本地处理', 'Edge 桌面下载行为'],
  },
  {
    id: 'ios17-device',
    platform: 'iOS 17+ 真机',
    requirement: '标准 Live Photo 识别、锁屏播放',
    autoChecks: [
      {
        title: '兼容矩阵声明 iOS 17+ 真机',
        sources: ['shared'],
        snippets: ["id: 'ios17-device'", "environment: 'iOS 17+ 真机'", 'lockScreenReady'],
      },
      {
        title: 'Phase 0 POC 要求相册识别和锁屏播放记录',
        sources: ['phase0Routes', 'livePhotoService'],
        snippets: [
          'Record whether Photos recognizes the pair as Live Photo.',
          'Record whether iOS 17+ lock screen playback works.',
          'Set as iOS 17+ lock screen wallpaper',
        ],
      },
    ],
    manualChecks: ['标准 Live Photo 识别', 'iOS 17+ 锁屏播放', '3 台 iPhone 覆盖', '两个 iOS 17+ 主要版本覆盖'],
  },
];

export async function collectCompatibilityMatrix(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, '兼容测试矩阵手动验收状态');

  return matrixDefinitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => {
      const source = joinSources(sources, check.sources);
      const missing = check.snippets.filter((snippet) => !source.includes(snippet));

      return {
        title: check.title,
        status: missing.length === 0 ? 'pass' : 'blocked',
        detail: missing.length === 0 ? '关键兼容实现片段已覆盖。' : `缺少实现片段：${missing.join(', ')}`,
      };
    });

    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed
        ? '兼容测试矩阵手动验收记录已标记通过。'
        : '需要补齐真实设备、浏览器版本、素材和结果证据后再标记通过。',
    }));

    const checks = [...autoResults, ...manualResults];
    const status = worstStatus(checks.map((check) => check.status));

    return {
      id: definition.id,
      platform: definition.platform,
      requirement: definition.requirement,
      status,
      autoResults,
      manualResults,
    };
  });
}

export function summarizeCompatibilityMatrix(items) {
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

export function formatCompatibilityMatrixReport(items) {
  const summary = summarizeCompatibilityMatrix(items);
  const lines = [
    'VidLive Compatibility Test Matrix',
    `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`,
    '',
  ];

  for (const item of items) {
    lines.push(`[${STATUS_LABEL[item.status]}] ${item.id} - ${item.platform}`);
    lines.push(`  必测项：${item.requirement}`);
    lines.push(`  自动检查：${formatCheckSummary(item.autoResults)}`);
    lines.push(`  手动证据：${formatCheckSummary(item.manualResults)}`);
  }

  return lines.join('\n');
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
  const items = await collectCompatibilityMatrix({ root: process.cwd() });
  const summary = summarizeCompatibilityMatrix(items);

  console.log(formatCompatibilityMatrixReport(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
