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
  ffmpegService: 'apps/api/src/services/ffmpeg/ffmpeg.service.ts',
  conversionRoutes: 'apps/api/src/modules/conversions/conversion.routes.ts',
  livePhotoService: 'apps/api/src/services/live-photo/live-photo.service.ts',
  record: '功能测试矩阵记录.md',
};

const matrixDefinitions = [
  {
    id: 'input-format',
    title: '输入格式',
    requirement: 'MP4、MOV、GIF、异常扩展名、损坏文件',
    autoChecks: [
      {
        title: '支持 MP4、MOV、GIF 声明',
        sources: ['shared'],
        snippets: ["extension: 'mp4'", "extension: 'mov'", "extension: 'gif'"],
      },
      {
        title: '异常扩展名走 unsupported-format',
        sources: ['shared', 'conversionRoutes', 'webTool'],
        snippets: ['unsupported-format', 'isSupportedUpload'],
      },
    ],
    manualChecks: ['MP4/MOV/GIF 正常样例', '异常扩展名拒绝样例', '损坏文件解析失败样例'],
  },
  {
    id: 'file-size',
    title: '文件大小',
    requirement: '10MB、50MB、100MB、超过 100MB',
    autoChecks: [
      {
        title: '本地 100MB 与云端 500MB 限制',
        sources: ['shared'],
        snippets: ['localFileSizeBytes: 100 * 1024 * 1024', 'cloudFileSizeBytes: 500 * 1024 * 1024'],
      },
      {
        title: '本地和云端均有大小拦截',
        sources: ['localExport', 'conversionRoutes'],
        snippets: [
          'file.size > productLimits.localFileSizeBytes',
          'sourceStat.size > config.cloudFileSizeBytes',
          'reply.status(413)',
        ],
      },
    ],
    manualChecks: ['10MB 本地流程', '50MB 本地流程', '100MB 边界流程', '超过 100MB 云端兜底'],
  },
  {
    id: 'duration',
    title: '时长',
    requirement: '1 秒、2 秒、3 秒、10 秒、30 秒、超过 30 秒',
    autoChecks: [
      {
        title: '最短 1 秒与推荐最长 30 秒',
        sources: ['shared'],
        snippets: ['minDurationSeconds: 1', 'recommendedMaxDurationSeconds: 30'],
      },
      {
        title: '裁剪起止点有边界约束',
        sources: ['localExport', 'livePhotoService'],
        snippets: ['draft.startSeconds', 'draft.endSeconds', 'clampNumber'],
      },
    ],
    manualChecks: ['1/2/3/10/30 秒样例', '超过 30 秒裁剪或提示样例'],
  },
  {
    id: 'aspect-ratio',
    title: '比例',
    requirement: '9:16、1:1、4:5、16:9、横屏转竖屏',
    autoChecks: [
      {
        title: '比例预设完整',
        sources: ['shared'],
        snippets: ["id: '9:16'", "id: '1:1'", "id: '4:5'", "id: '16:9'"],
      },
      {
        title: 'Canvas 与 FFmpeg 支持比例和旋转',
        sources: ['localExport', 'ffmpegService'],
        snippets: ['resolveCanvasSize', 'drawVideoFrame', 'rotationDegrees', 'transpose=1'],
      },
    ],
    manualChecks: ['四个比例导出样例', '横屏素材转 9:16 样例'],
  },
  {
    id: 'codec',
    title: '编码',
    requirement: 'H.264、HEVC、可变帧率、无音频、有音频',
    autoChecks: [
      {
        title: 'ffprobe 读取视频流、帧率和音频',
        sources: ['ffmpegService'],
        snippets: ['ffprobe', 'codec_type', 'avg_frame_rate', 'hasAudio'],
      },
      {
        title: '云端输出 H.264 MOV 且支持有/无音频',
        sources: ['ffmpegService', 'livePhotoService'],
        snippets: ['libx264', "'0:a?'", "'-an'", 'video.mov'],
      },
    ],
    manualChecks: ['H.264 样例', 'HEVC 样例', '可变帧率样例', '无音频样例', '有音频样例'],
  },
  {
    id: 'export',
    title: '导出',
    requirement: '标准 Live Photo、锁屏预设、MP4、GIF、ZIP',
    autoChecks: [
      {
        title: '导出预设覆盖标准、锁屏和兜底',
        sources: ['shared'],
        snippets: [
          "'standard-live-photo'",
          "'ios-lock-screen'",
          "'social-fallback'",
          "outputs: ['zip', 'mov', 'jpeg', 'mp4', 'webp']",
          "outputs: ['mp4', 'gif', 'webp']",
        ],
      },
      {
        title: '本地和云端均能生成 ZIP 包',
        sources: ['localExport', 'livePhotoService'],
        snippets: ['createZipArchive', 'createStoreZip', 'application/zip', 'manifest.json'],
      },
    ],
    manualChecks: ['标准 Live Photo 产物', '锁屏预设产物', 'MP4 产物', 'GIF 产物', 'ZIP 产物'],
  },
  {
    id: 'error',
    title: '错误',
    requirement: '文件过大、编码不支持、浏览器内存不足、云端超时',
    autoChecks: [
      {
        title: '失败原因和用户建议完整',
        sources: ['shared'],
        snippets: ['file-too-large', 'unsupported-format', 'browser-memory-low', 'cloud-timeout'],
      },
      {
        title: '前后端错误分流可定位',
        sources: ['webTool', 'conversionRoutes'],
        snippets: ["setFailureReason('cloud-timeout')", 'reply.status(413)', 'reply.status(415)'],
      },
    ],
    manualChecks: ['文件过大复现', '编码不支持复现', '浏览器内存不足复现', '云端超时复现'],
  },
];

export async function collectFunctionMatrix(options = {}) {
  const root = options.root ?? process.cwd();
  const sources = await readSources(root);
  const manualPassed = hasManualPassMarker(sources.record, '功能测试矩阵手动验收状态');

  return matrixDefinitions.map((definition) => {
    const autoResults = definition.autoChecks.map((check) => {
      const source = joinSources(sources, check.sources);
      const missing = check.snippets.filter((snippet) => !source.includes(snippet));

      return {
        title: check.title,
        status: missing.length === 0 ? 'pass' : 'blocked',
        detail: missing.length === 0 ? '关键实现片段已覆盖。' : `缺少实现片段：${missing.join(', ')}`,
      };
    });

    const manualResults = definition.manualChecks.map((title) => ({
      title,
      status: manualPassed ? 'pass' : 'blocked',
      detail: manualPassed
        ? '功能测试矩阵手动验收记录已标记通过。'
        : '需要补齐真实素材、环境和结果记录后再标记通过。',
    }));

    const checks = [...autoResults, ...manualResults];
    const status = worstStatus(checks.map((check) => check.status));

    return {
      id: definition.id,
      title: definition.title,
      requirement: definition.requirement,
      status,
      autoResults,
      manualResults,
    };
  });
}

export function summarizeFunctionMatrix(items) {
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

export function formatFunctionMatrixReport(items) {
  const summary = summarizeFunctionMatrix(items);
  const lines = [
    'VidLive Function Test Matrix',
    `Summary: PASS ${summary.pass}, BLOCKED ${summary.blocked}`,
    '',
  ];

  for (const item of items) {
    lines.push(`[${STATUS_LABEL[item.status]}] ${item.id} - ${item.title}`);
    lines.push(`  测试项：${item.requirement}`);
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
  const items = await collectFunctionMatrix({ root: process.cwd() });
  const summary = summarizeFunctionMatrix(items);

  console.log(formatFunctionMatrixReport(items));

  if (strict && summary.worstStatus !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
