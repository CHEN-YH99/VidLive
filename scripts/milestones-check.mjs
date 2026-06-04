/* global console, process */
import { fileURLToPath } from 'node:url';
import { collectPhaseGates } from './phase-gates.mjs';

const milestones = [
  {
    id: 'M0',
    title: '技术可行性确认',
    standard: 'Live Photo 生成、保存路径、锁屏测试有明确结论',
    requiredGateIds: ['phase0.ffmpeg', 'phase0.ffprobe', 'phase0.exiftool', 'phase0.manual-evidence'],
  },
  {
    id: 'M1',
    title: '本地编辑闭环',
    standard: '导入、预览、裁剪、关键帧选择可用',
    requiredGateIds: ['phase1.local-export', 'phase1.local-privacy-static'],
  },
  {
    id: 'M2',
    title: '导出闭环',
    standard: '标准预设和锁屏预设可生成产物',
    requiredGateIds: ['phase1.local-export', 'phase0.api'],
  },
  {
    id: 'M3',
    title: 'MVP 内测',
    standard: '无登录用户可完成一次完整导出',
    requiredGateIds: ['phase1.local-export', 'phase1.manual-evidence'],
  },
  {
    id: 'M4',
    title: 'Beta 公测',
    standard: '云端兜底、临时链接、移动端体验可用',
    requiredGateIds: ['phase2.cloud-api', 'phase2.cloud-ui', 'phase2.manual-evidence'],
  },
  {
    id: 'M5',
    title: 'V1.0 上线',
    standard: '账号、配额、AI、监控、上线流程可用',
    requiredGateIds: ['phase3.v1-api', 'phase3.basic-editing', 'phase3.manual-evidence'],
  },
  {
    id: 'M6',
    title: '商业化验证',
    standard: 'Pro 版和付费路径可验证',
    requiredGateIds: ['phase4.commercial-api', 'phase4.commercial-ui', 'phase4.manual-evidence'],
  },
];

export async function collectMilestones(options = {}) {
  const gates = await collectPhaseGates(options);
  const gateMap = new Map(gates.map((gate) => [gate.id, gate]));

  return milestones.map((milestone) => {
    const blockers = milestone.requiredGateIds
      .map((gateId) => gateMap.get(gateId))
      .filter((gate) => !gate || gate.status !== 'pass');

    return {
      ...milestone,
      status: blockers.length === 0 ? 'pass' : 'blocked',
      blockers: blockers.map((gate) => gate?.title ?? 'missing gate'),
    };
  });
}

export function formatMilestoneReport(items) {
  const pass = items.filter((item) => item.status === 'pass').length;
  const blocked = items.length - pass;
  const lines = ['VidLive Milestones', `Summary: PASS ${pass}, BLOCKED ${blocked}`, ''];

  for (const item of items) {
    lines.push(`[${item.status === 'pass' ? 'PASS' : 'BLOCKED'}] ${item.id} - ${item.title}`);
    lines.push(`  通过标准：${item.standard}`);

    if (item.blockers.length > 0) {
      lines.push(`  阻塞项：${item.blockers.join('、')}`);
    }
  }

  return lines.join('\n');
}

async function main() {
  const strict = process.argv.includes('--strict');
  const items = await collectMilestones({ root: process.cwd() });
  const hasBlocked = items.some((item) => item.status !== 'pass');

  console.log(formatMilestoneReport(items));

  if (strict && hasBlocked) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
