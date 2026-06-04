/* global console, process */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_ORDER = {
  pass: 0,
  warn: 1,
  blocked: 2,
};

const STATUS_LABEL = {
  pass: 'PASS',
  warn: 'WARN',
  blocked: 'BLOCKED',
};

export async function collectPhaseGates(options = {}) {
  const root = options.root ?? process.cwd();
  const gates = [];

  const [ffmpeg, ffprobe, exiftool] = await Promise.all([
    checkCommand('ffmpeg', ['-version']),
    checkCommand('ffprobe', ['-version']),
    checkCommand('exiftool', ['-ver']),
  ]);

  gates.push(commandGate('phase0.ffmpeg', 'FFmpeg 可用', ffmpeg));
  gates.push(commandGate('phase0.ffprobe', 'ffprobe 可用', ffprobe));
  gates.push({
    id: 'phase0.exiftool',
    phase: 'Phase 0',
    title: 'exiftool 元数据工具可用',
    status: exiftool.available ? 'pass' : 'blocked',
    detail: exiftool.available
      ? `检测到 exiftool ${exiftool.summary}`
      : '本机未检测到 exiftool，不能完成 Apple Live Photo 元数据注入验收。',
  });

  const dockerfile = await readOptional(root, 'apps/api/Dockerfile');
  gates.push({
    id: 'phase0.exiftool-container-fallback',
    phase: 'Phase 0',
    title: '容器环境包含 exiftool 兜底',
    status: dockerfile.includes('exiftool') ? 'pass' : 'warn',
    detail: dockerfile.includes('exiftool')
      ? 'API Dockerfile 已安装 exiftool CLI，可用容器补齐元数据验证环境。'
      : '未发现容器级 exiftool 安装路径。',
  });

  const phase0Routes = await readOptional(root, 'apps/api/src/modules/phase0/phase0.routes.ts');
  const livePhotoService = await readOptional(root, 'apps/api/src/services/live-photo/live-photo.service.ts');
  gates.push(staticGate('phase0.api', 'Phase 0 POC API 完整', 'Phase 0', phase0Routes + livePhotoService, [
    '/api/phase0/environment',
    '/api/phase0/checklist',
    '/api/phase0/live-photo-poc',
    'metadataReady',
    'exiftool-not-available',
  ]));

  const conversionRoutes = await readOptional(root, 'apps/api/src/modules/conversions/conversion.routes.ts');
  const conversionService = await readOptional(root, 'apps/api/src/modules/conversions/conversion.service.ts');
  const objectStorageService = await readOptional(root, 'apps/api/src/services/storage/object-storage.service.ts');
  gates.push(staticGate('phase2.cloud-api', 'Phase 2 云端任务 API', 'Phase 2', conversionRoutes + conversionService + objectStorageService, [
    '/api/conversions/cloud-jobs',
    '/api/conversions/cloud-jobs/:jobId/download',
    'deleteCloudJob',
    'local-temp-link',
    'CloudConversionStatus',
  ]));

  const localExport = await readOptional(root, 'apps/web/lib/local-export.ts');
  gates.push(staticGate('phase1.local-export', 'Phase 1 本地导出闭环', 'Phase 1', localExport, [
    'generateLocalExport',
    'cloud-required',
    'createZipArchive',
    '保存指引',
    'Apple Live Photo 完整元数据',
  ]));

  const localUploadMatches = ['fetch(', 'XMLHttpRequest', 'axios', 'new FormData'].filter((needle) =>
    localExport.includes(needle),
  );
  gates.push({
    id: 'phase1.local-privacy-static',
    phase: 'Phase 1',
    title: '本地导出函数无上传调用',
    status: localUploadMatches.length === 0 ? 'pass' : 'blocked',
    detail:
      localUploadMatches.length === 0
        ? 'generateLocalExport 未包含 fetch/XMLHttpRequest/axios/FormData。'
        : `本地导出函数出现疑似上传调用：${localUploadMatches.join(', ')}`,
  });

  const webTool = await readOptional(root, 'apps/web/components/vidlive-tool.tsx');
  gates.push(staticGate('phase2.cloud-ui', 'Phase 2 云端任务 UI', 'Phase 2', webTool, [
    'FormData',
    '/api/conversions/cloud-jobs',
    'CloudJobPanel',
    'refreshCloudJob',
    '提交云端任务',
  ]));

  const v1Routes = await readOptional(root, 'apps/api/src/modules/v1/v1.routes.ts');
  const v1Service = await readOptional(root, 'apps/api/src/modules/v1/v1.service.ts');
  gates.push(staticGate('phase3.v1-api', 'Phase 3 V1.0 API', 'Phase 3', v1Routes + v1Service, [
    '/api/v1/auth/register',
    '/api/v1/auth/login',
    '/api/v1/usage',
    '/api/v1/keyframes/recommendations',
    '/api/v1/compatibility-feedback',
    '/api/v1/metrics/summary',
    '/api/v1/launch-readiness',
  ]));

  const ffmpegService = await readOptional(root, 'apps/api/src/services/ffmpeg/ffmpeg.service.ts');
  gates.push(staticGate('phase3.basic-editing', 'Phase 3 基础编辑生效链路', 'Phase 3', localExport + ffmpegService + webTool, [
    'rotationDegrees',
    'flipHorizontal',
    'createCanvasFilter',
    'createVideoFilters',
    'NumberRangeField',
  ]));

  gates.push(staticGate('phase4.commercial-api', 'Phase 4 商业化 API', 'Phase 4', v1Routes + v1Service, [
    '/api/v1/billing/plans',
    '/api/v1/billing/checkout-intents',
    '/api/v1/batches',
    '/api/v1/history',
    '/api/v1/experiments/pro-cta',
    '/api/v1/admin/commercial-summary',
    'getCommercialSummary',
  ]));

  gates.push(staticGate('phase4.commercial-ui', 'Phase 4 商业化入口 UI', 'Phase 4', webTool, [
    'Pro Monthly',
    '批量处理',
    '4K 输出',
    '历史记录',
  ]));

  gates.push(staticGate('phase5.expansion-api', 'Phase 5 扩展平台 API', 'Phase 5', v1Routes + v1Service, [
    '/api/v1/tools',
    '/api/v1/templates',
    '/api/v1/api-keys',
    '/api/v1/extensions/browser-manifest',
    '/api/v1/desktop/manifest',
    '/api/v1/ecosystem/summary',
    'getExpansionTools',
  ]));

  gates.push(staticGate('phase5.expansion-ui', 'Phase 5 扩展工具箱 UI', 'Phase 5', webTool, [
    '扩展工具箱',
    'Live Photo to GIF/MP4',
    'Image to Live Photo',
    'AI Image Motion',
    'ToolboxItem',
  ]));

  const phase0Record = await readOptional(root, 'Phase0技术兼容验证记录.md');
  const phase0ManualPassed = hasManualPassMarker(phase0Record, 'Phase 0 手动验收状态');
  gates.push({
    id: 'phase0.manual-evidence',
    phase: 'Phase 0',
    title: 'Phase 0 真机与抓包证据',
    status: phase0ManualPassed ? 'pass' : 'blocked',
    detail: phase0ManualPassed
      ? 'Phase 0 手动验收记录已标记通过。'
      : '请补 3 台 iPhone、保存路径、锁屏播放和本地抓包记录后再标记通过。',
  });

  const phase1Record = await readOptional(root, 'Phase1MVP验收记录.md');
  const phase1ManualPassed = hasManualPassMarker(phase1Record, 'MVP 手动验收状态');
  gates.push({
    id: 'phase1.manual-evidence',
    phase: 'Phase 1',
    title: 'MVP 真机、性能与内测证据',
    status: phase1ManualPassed ? 'pass' : 'blocked',
    detail: phase1ManualPassed
      ? 'Phase 1 MVP 手动验收记录已标记通过。'
      : '请补兼容矩阵、P75 性能、保存路径和内测首导出耗时后再标记通过。',
  });

  const phase2Record = await readOptional(root, 'Phase2Beta验收记录.md');
  const phase2ManualPassed = hasManualPassMarker(phase2Record, 'Beta 手动验收状态');
  gates.push({
    id: 'phase2.manual-evidence',
    phase: 'Phase 2',
    title: 'Beta 云端兜底与产品化证据',
    status: phase2ManualPassed ? 'pass' : 'blocked',
    detail: phase2ManualPassed
      ? 'Phase 2 Beta 手动验收记录已标记通过。'
      : '请补云端任务、下载删除、过期、移动端、错误诊断和性能记录后再标记通过。',
  });

  const phase3Record = await readOptional(root, 'Phase3V1验收记录.md');
  const phase3ManualPassed = hasManualPassMarker(phase3Record, 'V1.0 手动验收状态');
  gates.push({
    id: 'phase3.manual-evidence',
    phase: 'Phase 3',
    title: 'V1.0 正式版验收证据',
    status: phase3ManualPassed ? 'pass' : 'blocked',
    detail: phase3ManualPassed
      ? 'Phase 3 V1.0 手动验收记录已标记通过。'
      : '请补账号、配额、AI、基础编辑、兼容反馈、监控和上线准备证据后再标记通过。',
  });

  const phase4Record = await readOptional(root, 'Phase4商业化验收记录.md');
  const phase4ManualPassed = hasManualPassMarker(phase4Record, '商业化手动验收状态');
  gates.push({
    id: 'phase4.manual-evidence',
    phase: 'Phase 4',
    title: '商业化验证证据',
    status: phase4ManualPassed ? 'pass' : 'blocked',
    detail: phase4ManualPassed
      ? 'Phase 4 商业化手动验收记录已标记通过。'
      : '请补支付、退款/取消、批量失败隔离、成本和免费转付费指标后再标记通过。',
  });

  const phase5Record = await readOptional(root, 'Phase5扩展阶段验收记录.md');
  const phase5ManualPassed = hasManualPassMarker(phase5Record, '扩展阶段手动验收状态');
  gates.push({
    id: 'phase5.manual-evidence',
    phase: 'Phase 5',
    title: '扩展阶段生态验证证据',
    status: phase5ManualPassed ? 'pass' : 'blocked',
    detail: phase5ManualPassed
      ? 'Phase 5 扩展阶段手动验收记录已标记通过。'
      : '请补多工具真实转换、API 调用、模板使用、插件/客户端分发和生态指标后再标记通过。',
  });

  return gates;
}

export function summarizeGates(gates) {
  return gates.reduce(
    (summary, gate) => {
      summary[gate.status] += 1;
      summary.worstStatus =
        STATUS_ORDER[gate.status] > STATUS_ORDER[summary.worstStatus] ? gate.status : summary.worstStatus;
      return summary;
    },
    { pass: 0, warn: 0, blocked: 0, worstStatus: 'pass' },
  );
}

export function formatGateReport(gates) {
  const summary = summarizeGates(gates);
  const lines = [
    'VidLive Phase Gate',
    `Summary: PASS ${summary.pass}, WARN ${summary.warn}, BLOCKED ${summary.blocked}`,
    '',
  ];

  for (const gate of gates) {
    lines.push(`[${STATUS_LABEL[gate.status]}] ${gate.phase} - ${gate.title}`);
    lines.push(`  ${gate.detail}`);
  }

  return lines.join('\n');
}

async function checkCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          available: false,
          summary: (stderr || error.message).split(/\r?\n/).find(Boolean) ?? 'not available',
        });
        return;
      }

      resolve({
        available: true,
        summary: stdout.split(/\r?\n/).find(Boolean) ?? 'available',
      });
    });
  });
}

function commandGate(id, title, result) {
  return {
    id,
    phase: 'Phase 0',
    title,
    status: result.available ? 'pass' : 'blocked',
    detail: result.available ? result.summary : `命令不可用：${result.summary}`,
  };
}

function staticGate(id, title, phase, source, requiredSnippets) {
  const missing = requiredSnippets.filter((snippet) => !source.includes(snippet));

  return {
    id,
    phase,
    title,
    status: missing.length === 0 ? 'pass' : 'blocked',
    detail: missing.length === 0 ? '关键实现片段已覆盖。' : `缺少实现片段：${missing.join(', ')}`,
  };
}

function hasManualPassMarker(content, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markerPattern = new RegExp(`(?:^|\\n)>?\\s*\\*\\*${escapedLabel}\\*\\*：通过\\s*(?:\\r?\\n|$)`);

  return markerPattern.test(content);
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
  const gates = await collectPhaseGates({ root: process.cwd() });
  const summary = summarizeGates(gates);

  console.log(formatGateReport(gates));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
