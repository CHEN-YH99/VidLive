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
  webPackage: 'apps/web/package.json',
  apiPackage: 'apps/api/package.json',
  dockerfile: 'apps/api/Dockerfile',
  phase0Routes: 'apps/api/src/modules/phase0/phase0.routes.ts',
  livePhotoService: 'apps/api/src/services/live-photo/live-photo.service.ts',
  conversionRoutes: 'apps/api/src/modules/conversions/conversion.routes.ts',
  env: 'apps/api/src/config/env.ts',
  v1Routes: 'apps/api/src/modules/v1/v1.routes.ts',
  v1Service: 'apps/api/src/modules/v1/v1.service.ts',
  phaseGates: 'scripts/phase-gates.mjs',
  phase3Smoke: 'scripts/phase3-smoke.mjs',
  record: '风险清单记录.md',
};

const riskDefinitions = [
  {
    id: 'live-photo-save-path',
    risk: 'Web 端无法稳定保存真正 Live Photo',
    phase: 'Phase 0',
    level: '高',
    response: '优先验证 Shortcuts、AirDrop、ZIP、MOV 路径',
    autoChecks: [
      {
        title: '保存路径覆盖 Shortcuts、AirDrop、ZIP',
        sources: ['shared', 'localExport', 'webTool'],
        snippets: ['Shortcuts', 'AirDrop', '桌面 ZIP 下载', '下载 ZIP 包'],
      },
      {
        title: 'Live Photo POC 产物包含 MOV 和手动验证说明',
        sources: ['phase0Routes', 'livePhotoService'],
        snippets: ['video.mov', 'manualVerification', 'Transfer the ZIP to an iPhone by AirDrop or Files.'],
      },
    ],
    manualChecks: ['至少一条真机保存路径跑通', '失败路径和替代路径记录'],
  },
  {
    id: 'lock-screen-rule-opaque',
    risk: '锁屏动态壁纸规则不透明',
    phase: 'Phase 0-1',
    level: '高',
    response: '建真机矩阵，锁屏模式给风险提示',
    autoChecks: [
      {
        title: '锁屏预设和锁屏失败提示已覆盖',
        sources: ['shared', 'webTool'],
        snippets: ["'ios-lock-screen'", 'lock-screen-not-playing', 'iPhone 锁屏路径'],
      },
      {
        title: '兼容矩阵保留锁屏播放状态',
        sources: ['shared'],
        snippets: ['lockScreenReady', 'iOS 17+ 真机', '锁屏播放有真机记录'],
      },
    ],
    manualChecks: ['iOS 17+ 锁屏播放矩阵', '失败条件记录'],
  },
  {
    id: 'local-transcode-performance',
    risk: '本地转码性能差',
    phase: 'Phase 0-1',
    level: '高',
    response: '限制 100MB，提前准备云端兜底',
    autoChecks: [
      {
        title: '本地大小限制和云端兜底提示已覆盖',
        sources: ['shared', 'localExport', 'webTool'],
        snippets: ['localFileSizeBytes: 100 * 1024 * 1024', 'cloud-required', 'cloudConsentConfirmed'],
      },
      {
        title: '性能检查门覆盖本地和云端 P75',
        sources: ['performanceCheck'],
        snippets: ['local-convert-10s-1080p', 'cloud-convert-30s-1080p'],
      },
    ],
    manualChecks: ['本地 10 秒 1080p P75', '云端兜底 P75'],
  },
  {
    id: 'cloud-architecture-overweight',
    risk: '技术文档云端架构过重',
    phase: 'Phase 1',
    level: '中',
    response: 'MVP 不依赖账号、数据库、R2',
    autoChecks: [
      {
        title: 'Web MVP 包不依赖数据库、R2 或账号 SDK',
        sources: ['webPackage'],
        forbiddenSnippets: ['@prisma/client', '@aws-sdk', '@fastify/jwt', 'stripe'],
      },
      {
        title: '本地导出和无上传静态门存在',
        sources: ['localExport', 'phaseGates'],
        snippets: ['generateLocalExport', 'local-privacy-static', 'generateLocalExport 未包含 fetch/XMLHttpRequest/axios/FormData'],
      },
    ],
    manualChecks: ['无登录 MVP 导出证据', 'MVP 环境不依赖 R2/数据库证据'],
  },
  {
    id: 'metadata-instability',
    risk: 'FFmpeg/exiftool 元数据方案不稳定',
    phase: 'Phase 0-2',
    level: '高',
    response: '真机验证，不迷信元数据注入代码',
    autoChecks: [
      {
        title: 'exiftool 缺失和失败都有警告',
        sources: ['phase0Routes', 'livePhotoService', 'phaseGates'],
        snippets: ['metadataReady', 'exiftool-not-available', 'exiftool-metadata-failed'],
      },
      {
        title: '容器内提供 exiftool 兜底',
        sources: ['dockerfile', 'phaseGates'],
        snippets: ['perl-image-exiftool', 'phase0.exiftool-container-fallback'],
      },
    ],
    manualChecks: ['真机 Live Photo 识别证据', '元数据失败样例记录'],
  },
  {
    id: 'mobile-timeline-usability',
    risk: '移动端时间轴交互难用',
    phase: 'Phase 1',
    level: '中',
    response: 'Week 4 开始真机调试',
    autoChecks: [
      {
        title: '时间轴控件和移动端操作入口已覆盖',
        sources: ['webTool'],
        snippets: ['Panel title="时间轴"', 'RangeField', 'sticky bottom-3', 'lg:static'],
      },
      {
        title: '兼容矩阵要求 iPhone Safari 流程',
        sources: ['shared'],
        snippets: ['iPhone Safari', 'trimReady', '重点看保存路径和锁屏播放。'],
      },
    ],
    manualChecks: ['iPhone Safari 时间轴操作录屏', '移动端问题清单'],
  },
  {
    id: 'cloud-cost-overrun',
    risk: '云端成本过高',
    phase: 'Phase 2-4',
    level: '中',
    response: '限额、自动删除、Pro 权益绑定',
    autoChecks: [
      {
        title: '云端大小上限和自动删除策略已覆盖',
        sources: ['shared', 'conversionRoutes', 'env'],
        snippets: ['cloudFileSizeBytes: 500 * 1024 * 1024', 'retentionHours', "readNumber('CLOUD_RETENTION_HOURS', 24)"],
      },
      {
        title: '配额、Pro 权益和付费边界已覆盖',
        sources: ['v1Service', 'webTool'],
        snippets: ['dailyQuota', 'Pro Monthly', 'quota: 100', 'pro-required'],
      },
    ],
    manualChecks: ['云端成本测算', '限额和 Pro 权益效果记录'],
  },
  {
    id: 'ai-keyframe-value',
    risk: 'AI 选帧价值不明显',
    phase: 'Phase 3',
    level: '中',
    response: '人工评估准确率，不达标不上线',
    autoChecks: [
      {
        title: 'AI 选帧接口和评分已覆盖',
        sources: ['v1Routes', 'v1Service', 'webTool'],
        snippets: ['/api/v1/keyframes/recommendations', 'score', 'AI 关键帧'],
      },
      {
        title: '人工评估目标和 smoke 检查已覆盖',
        sources: ['v1Routes', 'phase3Smoke'],
        snippets: ["reviewTarget: '人工评估准确率 >= 70%'", 'keyframe recommendations missing'],
      },
    ],
    manualChecks: ['人工评估准确率样本', '不达标不上线结论'],
  },
];

sourceFiles.performanceCheck = 'scripts/performance-check.mjs';

export async function collectRiskRegister(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, '风险清单手动验收状态');

  return riskDefinitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => evaluateAutoCheck(check, sources));
    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed ? '风险清单手动验收记录已标记通过。' : '需要补齐验证证据、负责人结论或下一步后再标记通过。',
    }));
    const checks = [...autoResults, ...manualResults];
    const status = worstStatus(checks.map((check) => check.status));

    return {
      id: definition.id,
      risk: definition.risk,
      phase: definition.phase,
      level: definition.level,
      response: definition.response,
      status,
      autoResults,
      manualResults,
    };
  });
}

export function summarizeRiskRegister(items) {
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

export function formatRiskRegisterReport(items) {
  const summary = summarizeRiskRegister(items);
  const lines = ['VidLive Risk Register', `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`, ''];

  for (const item of items) {
    lines.push(`[${STATUS_LABEL[item.status]}] ${item.id} - ${item.risk}`);
    lines.push(`  阶段/等级：${item.phase} / ${item.level}`);
    lines.push(`  应对：${item.response}`);
    lines.push(`  自动检查：${formatCheckSummary(item.autoResults)}`);
    lines.push(`  关闭证据：${formatCheckSummary(item.manualResults)}`);
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
      detail: '风险应对片段已覆盖。',
    };
  }

  return {
    title: check.title,
    status: 'blocked',
    detail: [
      missing.length > 0 ? `缺少应对片段：${missing.join(', ')}` : '',
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
  const items = await collectRiskRegister({ root: process.cwd() });
  const summary = summarizeRiskRegister(items);

  console.log(formatRiskRegisterReport(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
