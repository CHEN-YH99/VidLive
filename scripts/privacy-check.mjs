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
  localExport: 'apps/web/lib/local-export.ts',
  fileInspector: 'apps/web/lib/file-inspector.ts',
  webTool: 'apps/web/components/vidlive-tool.tsx',
  conversionRoutes: 'apps/api/src/modules/conversions/conversion.routes.ts',
  conversionService: 'apps/api/src/modules/conversions/conversion.service.ts',
  env: 'apps/api/src/config/env.ts',
  phase2Smoke: 'scripts/phase2-smoke.mjs',
  record: '隐私测试记录.md',
};

const privacyDefinitions = [
  {
    id: 'local-original-no-upload',
    title: '本地模式抓包确认不上传原始素材',
    autoChecks: [
      {
        title: '本地导出仅允许本地模式',
        sources: ['localExport'],
        snippets: ['generateLocalExport', "draft.mode === 'cloud'", "throw new Error('cloud-processing-not-enabled')"],
      },
      {
        title: '本地导出函数没有网络上传原语',
        sources: ['localExport'],
        forbiddenSnippets: ['fetch(', 'XMLHttpRequest', 'axios', 'new FormData'],
      },
    ],
    manualChecks: ['本地模式原始素材抓包记录', '本地模式无业务上传请求记录'],
  },
  {
    id: 'local-thumbnail-no-upload',
    title: '本地模式不上传缩略图',
    autoChecks: [
      {
        title: '封面帧在浏览器本地生成',
        sources: ['fileInspector', 'localExport'],
        snippets: ['captureCoverFrame', 'canvas.toDataURL', 'coverBlob', 'dataUrlToBlob'],
      },
      {
        title: '文件检查和封面帧逻辑没有网络上传原语',
        sources: ['fileInspector'],
        forbiddenSnippets: ['fetch(', 'XMLHttpRequest', 'axios', 'new FormData'],
      },
    ],
    manualChecks: ['本地模式缩略图抓包记录', '无封面帧上传请求记录'],
  },
  {
    id: 'cloud-consent-before-upload',
    title: '云端模式上传前必须出现确认',
    autoChecks: [
      {
        title: '后端云端意图声明需要用户同意',
        sources: ['conversionRoutes'],
        snippets: ['/api/conversions/cloud-intents', 'requiresConsent: true', 'defaultRetentionHours'],
      },
      {
        title: '前端云端上传前有确认状态',
        sources: ['webTool'],
        snippets: ['cloudConsentConfirmed', 'setCloudConsentConfirmed', 'FormData', '云端上传确认'],
      },
    ],
    manualChecks: ['未确认时不能上传证据', '确认后才上传证据'],
  },
  {
    id: 'cloud-expiry-auto-delete',
    title: '云端文件到期自动删除',
    autoChecks: [
      {
        title: '云端任务写入过期时间并清理文件',
        sources: ['conversionService'],
        snippets: ['expiresAt', 'cleanupExpiredJobs', "job.status = 'expired'", 'removeJobFiles'],
      },
      {
        title: '云端默认保留 24 小时并向接口暴露',
        sources: ['conversionRoutes', 'env'],
        snippets: ['retentionHours: config.cloudRetentionHours', 'defaultRetentionHours', "readNumber('CLOUD_RETENTION_HOURS', 24)"],
      },
    ],
    manualChecks: ['到期后任务状态 expired 证据', '到期后下载链接 404 证据'],
  },
  {
    id: 'manual-delete-invalidates-link',
    title: '手动删除后链接立即失效',
    autoChecks: [
      {
        title: 'DELETE 接口删除云端任务并移除文件',
        sources: ['conversionRoutes', 'conversionService'],
        snippets: ['server.delete', 'deleteCloudJob', 'this.jobs.delete(id)', 'download-not-ready'],
      },
      {
        title: 'Phase 2 smoke 覆盖删除后下载 404',
        sources: ['phase2Smoke'],
        snippets: ['deleteJob', 'downloadResponse.status !== 404', 'Deleted cloud job is still downloadable.'],
      },
    ],
    manualChecks: ['手动删除操作证据', '删除后原下载链接 404 证据'],
  },
];

export async function collectPrivacyChecks(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, '隐私测试手动验收状态');

  return privacyDefinitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => evaluateAutoCheck(check, sources));
    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed ? '隐私测试手动验收记录已标记通过。' : '需要补齐抓包、截图或接口状态码证据后再标记通过。',
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

export function summarizePrivacyChecks(items) {
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

export function formatPrivacyReport(items) {
  const summary = summarizePrivacyChecks(items);
  const lines = ['VidLive Privacy Test', `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`, ''];

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
  const forbidden = (check.forbiddenSnippets ?? []).filter((snippet) => source.includes(snippet));

  if (missing.length === 0 && forbidden.length === 0) {
    return {
      title: check.title,
      status: 'pass',
      detail: '关键隐私实现片段已覆盖。',
    };
  }

  return {
    title: check.title,
    status: 'blocked',
    detail: [
      missing.length > 0 ? `缺少实现片段：${missing.join(', ')}` : '',
      forbidden.length > 0 ? `出现禁止片段：${forbidden.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('；'),
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
  const items = await collectPrivacyChecks({ root: process.cwd() });
  const summary = summarizePrivacyChecks(items);

  console.log(formatPrivacyReport(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
