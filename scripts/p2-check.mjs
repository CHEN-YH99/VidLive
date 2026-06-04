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
  ffmpegService: 'apps/api/src/services/ffmpeg/ffmpeg.service.ts',
  livePhotoService: 'apps/api/src/services/live-photo/live-photo.service.ts',
  v1Routes: 'apps/api/src/modules/v1/v1.routes.ts',
  v1Service: 'apps/api/src/modules/v1/v1.service.ts',
  prismaSchema: 'apps/api/prisma/schema.prisma',
  phase3Smoke: 'scripts/phase3-smoke.mjs',
  phase4Smoke: 'scripts/phase4-smoke.mjs',
  record: 'P2V1后做清单记录.md',
};

const p2Definitions = [
  {
    id: 'user-system',
    title: '用户系统',
    autoChecks: [
      {
        title: '注册、登录和用户信息 API 已覆盖',
        sources: ['v1Routes'],
        snippets: ['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/me', 'authenticateRequest'],
      },
      {
        title: '密码哈希和 token 鉴权已覆盖',
        sources: ['v1Service', 'prismaSchema', 'phase3Smoke'],
        snippets: ['hashPassword', 'scrypt', 'signToken', 'authenticate(token', 'User'],
      },
    ],
    manualChecks: ['持久化注册登录记录', '登录态过期和错误凭证记录'],
  },
  {
    id: 'quota-history',
    title: '配额和历史记录',
    autoChecks: [
      {
        title: '配额扣减和超限已覆盖',
        sources: ['v1Routes', 'v1Service', 'phase3Smoke'],
        snippets: ['/api/v1/usage', 'consumeConversionQuota', 'quota-exceeded', 'quota did not block the sixth conversion'],
      },
      {
        title: '历史记录 API 已覆盖',
        sources: ['v1Routes', 'v1Service', 'phase4Smoke'],
        snippets: ['/api/v1/history', 'usageLogs', 'batches', 'checkouts', 'history missing commercial records'],
      },
    ],
    manualChecks: ['配额跨天和并发扣减记录', '历史持久化记录'],
  },
  {
    id: 'ai-keyframe',
    title: 'AI 关键帧',
    autoChecks: [
      {
        title: '关键帧推荐 API 已覆盖',
        sources: ['v1Routes', 'v1Service', 'phase3Smoke'],
        snippets: ['/api/v1/keyframes/recommendations', 'recommendKeyframes', 'score', 'heuristic-v1'],
      },
      {
        title: '前端关键帧建议入口已覆盖',
        sources: ['webTool'],
        snippets: ['AI 关键帧', 'createKeyframeSuggestions', 'keyframeSuggestions', 'updateKeyframe'],
      },
    ],
    manualChecks: ['人工评估准确率记录', '错误推荐样例记录'],
  },
  {
    id: 'webp-export',
    title: 'WebP 导出',
    autoChecks: [
      {
        title: '本地 WebP 导出已覆盖',
        sources: ['shared', 'localExport'],
        snippets: ["'webp'", 'webp-preview', 'image/webp', 'createWebpFrameBlob'],
      },
      {
        title: '云端 animated WebP 和 ZIP 打包已覆盖',
        sources: ['ffmpegService', 'livePhotoService'],
        snippets: ['clipToWebp', 'libwebp', 'animated.webp', "entryName: 'animated.webp'"],
      },
    ],
    manualChecks: ['本地 WebP 打开记录', '云端 animated WebP 打开和大小记录'],
  },
  {
    id: 'paid-subscription',
    title: '付费订阅',
    autoChecks: [
      {
        title: '订阅计划和 checkout API 已覆盖',
        sources: ['v1Routes', 'v1Service'],
        snippets: ['/api/v1/billing/plans', '/api/v1/billing/checkout-intents', 'mock-stripe', 'Pro Monthly'],
      },
      {
        title: '确认和取消订阅已覆盖',
        sources: ['v1Routes', 'v1Service', 'phase4Smoke'],
        snippets: ['confirmCheckoutIntent', 'cancelSubscription', 'billing.subscription_started', 'subscription cancel did not downgrade user'],
      },
    ],
    manualChecks: ['真实支付沙箱回调记录', '退款或取消记录'],
  },
  {
    id: 'batch-processing',
    title: '批量处理',
    autoChecks: [
      {
        title: '批量处理 API 和 Pro 限制已覆盖',
        sources: ['v1Routes', 'v1Service'],
        snippets: ['/api/v1/batches', 'createBatch', 'pro-required', 'invalid-batch-size'],
      },
      {
        title: '批量历史和 smoke 已覆盖',
        sources: ['v1Service', 'phase4Smoke'],
        snippets: ['batch.created', 'getBatch', 'Pro batch did not complete', 'batch.items?.length === 3'],
      },
    ],
    manualChecks: ['批量失败隔离记录', '批量重试和取消记录'],
  },
  {
    id: 'four-k-output',
    title: '4K 输出',
    autoChecks: [
      {
        title: '4K 参数和 Pro 权益已覆盖',
        sources: ['v1Routes', 'v1Service', 'webTool', 'phase4Smoke'],
        snippets: ["outputQuality?: 'standard' | '4k'", "outputQuality: '4k'", '4K 输出', 'Pro Cinematic 4K'],
      },
      {
        title: '4K 批量限制和 smoke 已覆盖',
        sources: ['v1Service', 'phase4Smoke'],
        snippets: ['Batch processing and 4K output require Pro.', "outputQuality: '4k'", 'Free user should not create Pro batch'],
      },
    ],
    manualChecks: ['4K 导出产物记录', '4K 耗时和成本记录'],
  },
];

export async function collectP2Checks(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, 'P2 V1 后做清单手动验收状态');

  return p2Definitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => evaluateAutoCheck(check, sources));
    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed ? 'P2 V1 后做清单手动验收记录已标记通过。' : '需要补齐真实持久化、支付、WebP、批量或 4K 证据后再标记通过。',
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

export function summarizeP2Checks(items) {
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

export function formatP2Report(items) {
  const summary = summarizeP2Checks(items);
  const lines = ['VidLive P2 Checklist', `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`, ''];

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
      detail: 'P2 实现片段已覆盖。',
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
  const items = await collectP2Checks({ root: process.cwd() });
  const summary = summarizeP2Checks(items);

  console.log(formatP2Report(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
