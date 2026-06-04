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
  apiPackage: 'apps/api/package.json',
  webPackage: 'apps/web/package.json',
  shared: 'packages/shared/src/index.ts',
  webTool: 'apps/web/components/vidlive-tool.tsx',
  localExport: 'apps/web/lib/local-export.ts',
  server: 'apps/api/src/server.ts',
  env: 'apps/api/src/config/env.ts',
  conversionRoutes: 'apps/api/src/modules/conversions/conversion.routes.ts',
  conversionService: 'apps/api/src/modules/conversions/conversion.service.ts',
  worker: 'apps/api/src/worker/index.ts',
  objectStorage: 'apps/api/src/services/storage/object-storage.service.ts',
  ffmpegService: 'apps/api/src/services/ffmpeg/ffmpeg.service.ts',
  record: 'P1尽快做清单记录.md',
};

const p1Definitions = [
  {
    id: 'cloud-processing-fallback',
    title: '云端处理兜底',
    autoChecks: [
      {
        title: '前端云端模式和上传确认已覆盖',
        sources: ['webTool'],
        snippets: ['mode: \'cloud\'', 'cloudConsentConfirmed', '/api/conversions/cloud-jobs', '提交云端任务'],
      },
      {
        title: '本地失败或超限可切云端',
        sources: ['localExport', 'conversionRoutes', 'shared'],
        snippets: ["throw new Error('cloud-required')", '/api/conversions/cloud-intents', 'cloudFileSizeBytes'],
      },
    ],
    manualChecks: ['本地超限切云端记录', '本地失败切云端记录'],
  },
  {
    id: 'fastify-upload-convert-status-api',
    title: 'Fastify 上传/转换/状态 API',
    autoChecks: [
      {
        title: 'Fastify multipart 上传和任务 API 已覆盖',
        sources: ['server', 'conversionRoutes'],
        snippets: [
          'Fastify',
          'multipart',
          "server.post<{ Querystring: CloudJobQuery }>('/api/conversions/cloud-jobs'",
          "server.get<{ Params: CloudJobParams }>('/api/conversions/cloud-jobs/:jobId'",
        ],
      },
      {
        title: '下载、删除和指标 API 已覆盖',
        sources: ['conversionRoutes', 'conversionService'],
        snippets: [
          "/api/conversions/cloud-jobs/:jobId/download",
          "server.delete<{ Params: CloudJobParams }>",
          '/api/conversions/metrics',
          'getMetrics',
        ],
      },
    ],
    manualChecks: ['真实上传状态轮询记录', '下载删除异常返回记录'],
  },
  {
    id: 'redis-bullmq-worker',
    title: 'Redis + BullMQ Worker',
    autoChecks: [
      {
        title: '依赖和 worker 启动脚本已覆盖',
        sources: ['apiPackage', 'worker', 'env'],
        snippets: ['"bullmq"', '"ioredis"', '"worker"', 'REDIS_URL', 'redis-url-required-for-bullmq-worker'],
      },
      {
        title: 'BullMQ Queue 和 Worker 已接入转换服务',
        sources: ['conversionService'],
        snippets: ['new Queue<CloudConversionJobRecord', 'new Worker<CloudConversionJobRecord', 'redis-bullmq', 'attempts: 2'],
      },
    ],
    manualChecks: ['Redis 入队消费记录', 'BullMQ 失败重试记录'],
  },
  {
    id: 'r2-temporary-links',
    title: 'R2 临时链接',
    autoChecks: [
      {
        title: 'R2/S3 SDK 和签名 URL 已覆盖',
        sources: ['apiPackage', 'objectStorage'],
        snippets: ['"@aws-sdk/client-s3"', '"@aws-sdk/s3-request-presigner"', 'S3Client', 'getSignedUrl'],
      },
      {
        title: 'R2 artifact 存储和删除入口已覆盖',
        sources: ['env', 'objectStorage', 'conversionService'],
        snippets: ['r2SignedUrlTtlSeconds', 'r2-signed-url', 'storeArtifact', 'deleteArtifact', 'signedUrlExpiresAt'],
      },
    ],
    manualChecks: ['R2 签名链接可用记录', 'R2 过期和删除失效记录'],
  },
  {
    id: 'rotate-flip-background-fill',
    title: '旋转、翻转、背景色填充',
    autoChecks: [
      {
        title: 'Web 控件和 shared draft 已覆盖',
        sources: ['shared', 'webTool'],
        snippets: ['backgroundColor', 'backgroundColorOptions', 'Palette', '背景色', 'flipHorizontal', 'flipVertical'],
      },
      {
        title: '本地 Canvas 和云端 FFmpeg 滤镜已覆盖',
        sources: ['localExport', 'ffmpegService'],
        snippets: ['normalizeBackgroundColor', 'context.fillStyle', 'transpose=1', 'pad=', 'toFfmpegColor'],
      },
    ],
    manualChecks: ['旋转翻转导出样例', '背景色填充导出样例'],
  },
  {
    id: 'qr-send-to-phone',
    title: '二维码发送到手机',
    autoChecks: [
      {
        title: '二维码依赖已覆盖',
        sources: ['webPackage'],
        snippets: ['"qrcode"', '"@types/qrcode"'],
      },
      {
        title: '云端任务完成后 QR 下载入口已覆盖',
        sources: ['webTool'],
        snippets: ['QRCode.toDataURL', 'aria-label="二维码发送到手机"', '手机扫码下载', 'downloadUrl'],
      },
    ],
    manualChecks: ['手机扫码下载记录', '二维码链接过期处理记录'],
  },
  {
    id: 'basic-monitoring-logs',
    title: '基础监控和日志',
    autoChecks: [
      {
        title: 'Fastify/Pino 日志和错误处理已覆盖',
        sources: ['server', 'conversionService'],
        snippets: ['logger', 'setErrorHandler', 'logger?.info', 'logger?.error'],
      },
      {
        title: '转换指标端点已覆盖',
        sources: ['conversionRoutes', 'conversionService'],
        snippets: ['/api/conversions/metrics', 'CloudConversionMetrics', 'queueCounts', 'activeJobs'],
      },
    ],
    manualChecks: ['成功失败日志样例', 'metrics JSON 记录'],
  },
];

export async function collectP1Checks(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, 'P1 尽快做清单手动验收状态');

  return p1Definitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => evaluateAutoCheck(check, sources));
    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed ? 'P1 尽快做清单手动验收记录已标记通过。' : '需要补齐真实 Redis、R2、扫码、日志或转换证据后再标记通过。',
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

export function summarizeP1Checks(items) {
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

export function formatP1Report(items) {
  const summary = summarizeP1Checks(items);
  const lines = ['VidLive P1 Checklist', `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`, ''];

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
      detail: 'P1 实现片段已覆盖。',
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
  const items = await collectP1Checks({ root: process.cwd() });
  const summary = summarizeP1Checks(items);

  console.log(formatP1Report(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
