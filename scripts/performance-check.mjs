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
  rootPackage: 'package.json',
  webPackage: 'apps/web/package.json',
  page: 'apps/web/app/page.tsx',
  webTool: 'apps/web/components/vidlive-tool.tsx',
  shared: 'packages/shared/src/index.ts',
  fileInspector: 'apps/web/lib/file-inspector.ts',
  localExport: 'apps/web/lib/local-export.ts',
  ffmpegService: 'apps/api/src/services/ffmpeg/ffmpeg.service.ts',
  conversionRoutes: 'apps/api/src/modules/conversions/conversion.routes.ts',
  conversionService: 'apps/api/src/modules/conversions/conversion.service.ts',
  livePhotoService: 'apps/api/src/services/live-photo/live-photo.service.ts',
  phase2Smoke: 'scripts/phase2-smoke.mjs',
  record: '性能测试记录.md',
};

const performanceDefinitions = [
  {
    id: 'first-interactive',
    title: '首屏可交互',
    target: '小于 3 秒',
    autoChecks: [
      {
        title: '首页直接渲染工具页',
        sources: ['page', 'webTool'],
        snippets: ['VidLiveTool', 'export function VidLiveTool', 'UploadPanel'],
      },
      {
        title: '生产构建和启动脚本存在',
        sources: ['rootPackage', 'webPackage'],
        snippets: ['"build": "pnpm -r run build"', '"build": "next build"', '"start": "next start"'],
      },
    ],
    manualChecks: ['首屏可交互 P75 样本', '浏览器或 Lighthouse 证据'],
  },
  {
    id: 'local-parse-100mb',
    title: '本地解析 100MB 内视频',
    target: 'P75 小于 10 秒',
    autoChecks: [
      {
        title: '本地 100MB 上限明确',
        sources: ['shared', 'webTool'],
        snippets: ['localFileSizeBytes: 100 * 1024 * 1024', 'productLimits.localFileSizeBytes'],
      },
      {
        title: '浏览器本地 metadata 解析链路存在',
        sources: ['fileInspector', 'webTool'],
        snippets: ['inspectVideoFile', "video.preload = 'metadata'", 'URL.createObjectURL'],
      },
    ],
    manualChecks: ['100MB 内素材解析耗时样本', '解析 P75 小于 10 秒证据'],
  },
  {
    id: 'local-convert-10s-1080p',
    title: '本地转换 10 秒 1080p 视频',
    target: 'P75 小于 60 秒',
    autoChecks: [
      {
        title: '10 秒本地目标和本地导出链路存在',
        sources: ['shared', 'localExport'],
        snippets: ['localTargetDurationSeconds: 10', 'generateLocalExport', 'MediaRecorder'],
      },
      {
        title: '本地转换有运行时耗时保护',
        sources: ['localExport'],
        snippets: ['performance.now()', 'maxRuntimeMs', 'local-transcode-failed'],
      },
    ],
    manualChecks: ['10 秒 1080p 本地转换耗时样本', '本地转换 P75 小于 60 秒证据'],
  },
  {
    id: 'cloud-convert-30s-1080p',
    title: '云端转换 30 秒 1080p 视频',
    target: 'P75 小于 30 秒',
    autoChecks: [
      {
        title: '30 秒推荐上限和云端任务链路存在',
        sources: ['shared', 'conversionRoutes', 'conversionService'],
        snippets: ['recommendedMaxDurationSeconds: 30', '/api/conversions/cloud-jobs', 'processJob'],
      },
      {
        title: '云端 FFmpeg 转换和 smoke 验证入口存在',
        sources: ['ffmpegService', 'livePhotoService', 'phase2Smoke'],
        snippets: ['clipToMov', 'LivePhotoService', 'waitForCompletedJob'],
      },
    ],
    manualChecks: ['30 秒 1080p 云端转换耗时样本', '云端转换 P75 小于 30 秒证据'],
  },
  {
    id: 'export-package',
    title: '导出包生成',
    target: 'P75 小于 10 秒',
    autoChecks: [
      {
        title: '本地 ZIP 打包链路存在',
        sources: ['localExport'],
        snippets: ['createZipArchive', 'packageEntries', 'application/zip'],
      },
      {
        title: '云端 ZIP 打包和产物大小检查存在',
        sources: ['livePhotoService', 'conversionService'],
        snippets: ['createStoreZip', 'packageStat', 'sizeBytes'],
      },
    ],
    manualChecks: ['导出包生成耗时样本', '导出包 P75 小于 10 秒证据'],
  },
];

export async function collectPerformanceChecks(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, '性能测试手动验收状态');

  return performanceDefinitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => evaluateAutoCheck(check, sources));
    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed ? '性能测试手动验收记录已标记通过。' : '需要补齐真实样本、P75 和环境证据后再标记通过。',
    }));
    const checks = [...autoResults, ...manualResults];
    const status = worstStatus(checks.map((check) => check.status));

    return {
      id: definition.id,
      title: definition.title,
      target: definition.target,
      status,
      autoResults,
      manualResults,
    };
  });
}

export function summarizePerformanceChecks(items) {
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

export function formatPerformanceReport(items) {
  const summary = summarizePerformanceChecks(items);
  const lines = ['VidLive Performance Test', `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`, ''];

  for (const item of items) {
    lines.push(`[${STATUS_LABEL[item.status]}] ${item.id} - ${item.title}`);
    lines.push(`  目标：${item.target}`);
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
      detail: '关键性能实现片段已覆盖。',
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
  const items = await collectPerformanceChecks({ root: process.cwd() });
  const summary = summarizePerformanceChecks(items);

  console.log(formatPerformanceReport(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
