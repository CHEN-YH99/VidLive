import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  compatibilitySampleId,
  type CompatibilityConfidence,
  type CompatibilityDownloadResult,
  type CompatibilityEnvironmentSummary,
  type CompatibilityOsName,
  type CompatibilityReport,
  type CompatibilityReportInput,
  type CompatibilitySummary,
  type CompatibilityTestKit,
  type CompatibilityTransferPath,
  type CompatibilityViewerId,
  type CompatibilityViewerOutcome,
  type CompatibilityViewerReport,
  type CompatibilityViewerSummary,
} from '@vidlive/shared';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { FfmpegService } from '../../services/ffmpeg/ffmpeg.service.js';
import { AndroidMotionPhotoService } from '../../services/motion-photo/android-motion-photo.service.js';

interface TestKitParams {
  sampleId: string;
}

type StoredCompatibilityReport = CompatibilityReport & {
  ipHash: string;
};

const execFileAsync = promisify(execFile);
const sampleFileName = 'motion-photo_MP.jpg';
const metadataFileName = 'test-kit.json';
const reportsFileName = 'reports.jsonl';
const maxReportsForSummary = 5000;
const duplicateWindowMs = 10 * 60 * 1000;
const duplicateLimit = 3;

const osNames = new Set<CompatibilityOsName>(['Android', 'HarmonyOS', 'Other']);
const downloadResults = new Set<CompatibilityDownloadResult>(['success', 'failed', 'unknown']);
const transferPaths = new Set<CompatibilityTransferPath>([
  'browser-direct',
  'usb',
  'wechat',
  'qq',
  'cloud-drive',
  'unknown',
]);
const viewerIds = new Set<CompatibilityViewerId>([
  'system-gallery',
  'google-photos',
  'douyin',
  'file-manager',
  'wechat',
  'other',
]);
const viewerOutcomes = new Set<CompatibilityViewerOutcome>(['recognized', 'still', 'failed', 'not-tested']);

export function registerCompatibilityRoutes(server: FastifyInstance, config: AppConfig): void {
  const ffmpeg = new FfmpegService();
  const androidMotionPhoto = new AndroidMotionPhotoService();
  let testKitPromise: Promise<CompatibilityTestKit> | null = null;

  function getTestKit(): Promise<CompatibilityTestKit> {
    testKitPromise ??= ensureTestKit(config, ffmpeg, androidMotionPhoto);

    return testKitPromise.catch((error) => {
      testKitPromise = null;
      throw error;
    });
  }

  server.get('/api/compatibility/test-kit', async () => {
    return getTestKit();
  });

  server.get<{ Params: TestKitParams }>('/api/compatibility/test-kit/:sampleId/download', async (request, reply) => {
    if (request.params.sampleId !== compatibilitySampleId) {
      return reply.status(404).send({
        code: 'compatibility-sample-not-found',
        message: 'Compatibility sample was not found.',
      });
    }

    const testKit = await getTestKit();
    const samplePath = getSamplePath(config);

    reply.header('Content-Type', 'image/jpeg');
    reply.header('Content-Length', testKit.sizeBytes.toString());
    reply.header('Content-Disposition', `attachment; filename="${testKit.fileName}"`);

    return reply.send(createReadStream(samplePath));
  });

  server.post<{ Body: unknown }>('/api/compatibility/reports', async (request, reply) => {
    const testKit = await getTestKit();
    const parsed = parseCompatibilityReport(request.body, testKit);

    if (!parsed.ok) {
      return reply.status(400).send({
        code: 'invalid-compatibility-report',
        message: parsed.message,
      });
    }

    const reports = await readReports(config);
    const ipHash = hashClientIp(request.ip, config.jwtSecret);
    const duplicateCount = reports.filter((report) => {
      return (
        report.ipHash === ipHash &&
        report.sampleId === testKit.sampleId &&
        Date.now() - Date.parse(report.createdAt) < duplicateWindowMs
      );
    }).length;

    if (duplicateCount >= duplicateLimit) {
      return reply.status(429).send({
        code: 'compatibility-report-rate-limited',
        message: 'Too many compatibility reports from this client. Please try later.',
      });
    }

    const report: StoredCompatibilityReport = {
      ...parsed.report,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      confidence: inferConfidence(parsed.report),
      userAgent: cleanString(request.headers['user-agent'], 500) ?? 'unknown',
      ipHash,
    };

    await appendReport(config, report);

    return reply.status(201).send({
      report: stripPrivateReportFields(report),
      summary: createSummary(testKit.sampleId, [...reports, report]),
    });
  });

  server.get('/api/compatibility/summary', async () => {
    const testKit = await getTestKit();
    const reports = await readReports(config);

    return createSummary(testKit.sampleId, reports);
  });

  server.get('/api/compatibility/reports.csv', async (_request, reply) => {
    const reports = (await readReports(config)).map(stripPrivateReportFields);
    const csv = createReportsCsv(reports);

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="vidlive-compatibility-reports.csv"');

    return csv;
  });
}

async function ensureTestKit(
  config: AppConfig,
  ffmpeg: FfmpegService,
  androidMotionPhoto: AndroidMotionPhotoService,
): Promise<CompatibilityTestKit> {
  const samplePath = getSamplePath(config);
  const metadataPath = path.join(getTestKitDir(config), metadataFileName);
  const existing = await readExistingTestKit(metadataPath, samplePath);

  if (existing) {
    return existing;
  }

  const testKitDir = getTestKitDir(config);
  const sourcePath = path.join(testKitDir, 'sample-source.mp4');
  const photoPath = path.join(testKitDir, 'sample-photo.jpg');

  await mkdir(testKitDir, { recursive: true });
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=720x1280:rate=30:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:duration=2',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'baseline',
      '-level',
      '4.1',
      '-bf',
      '0',
      '-preset',
      'fast',
      '-crf',
      '24',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ar',
      '44100',
      sourcePath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  await ffmpeg.extractJpegFrame({
    inputPath: sourcePath,
    outputPath: photoPath,
    timestampSeconds: 1,
  });
  await androidMotionPhoto.generate({
    photoPath,
    videoPath: sourcePath,
    outputPath: samplePath,
    presentationTimestampUs: 1_000_000,
  });

  const testKit = await createTestKitMetadata(samplePath);

  await writeFile(metadataPath, JSON.stringify(testKit, null, 2));

  return testKit;
}

async function readExistingTestKit(metadataPath: string, samplePath: string): Promise<CompatibilityTestKit | null> {
  try {
    const [metadataRaw, sampleStat] = await Promise.all([readFile(metadataPath, 'utf8'), stat(samplePath)]);
    const metadata = JSON.parse(metadataRaw) as CompatibilityTestKit;

    if (
      metadata.sampleId === compatibilitySampleId &&
      metadata.fileName === sampleFileName &&
      metadata.sizeBytes === sampleStat.size
    ) {
      return metadata;
    }
  } catch {
    return null;
  }

  return null;
}

async function createTestKitMetadata(samplePath: string): Promise<CompatibilityTestKit> {
  const sample = await readFile(samplePath);

  return {
    sampleId: compatibilitySampleId,
    fileName: sampleFileName,
    downloadUrl: `/api/compatibility/test-kit/${compatibilitySampleId}/download`,
    sha256: createHash('sha256').update(sample).digest('hex'),
    sizeBytes: sample.length,
    generatedAt: new Date().toISOString(),
  };
}

function getCompatibilityDir(config: AppConfig): string {
  return path.resolve(config.uploadDir, 'compatibility');
}

function getTestKitDir(config: AppConfig): string {
  return path.join(getCompatibilityDir(config), 'test-kit', compatibilitySampleId);
}

function getSamplePath(config: AppConfig): string {
  return path.join(getTestKitDir(config), sampleFileName);
}

function getReportsPath(config: AppConfig): string {
  return path.join(getCompatibilityDir(config), reportsFileName);
}

async function appendReport(config: AppConfig, report: StoredCompatibilityReport): Promise<void> {
  await mkdir(getCompatibilityDir(config), { recursive: true });
  await appendFile(getReportsPath(config), `${JSON.stringify(report)}\n`, 'utf8');
}

async function readReports(config: AppConfig): Promise<StoredCompatibilityReport[]> {
  try {
    const content = await readFile(getReportsPath(config), 'utf8');

    return content
      .split('\n')
      .filter(Boolean)
      .slice(-maxReportsForSummary)
      .map((line) => JSON.parse(line) as StoredCompatibilityReport)
      .filter(isStoredReport);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function parseCompatibilityReport(
  body: unknown,
  testKit: CompatibilityTestKit,
): { ok: true; report: CompatibilityReportInput } | { ok: false; message: string } {
  if (!isRecord(body)) {
    return { ok: false, message: 'Report body must be an object.' };
  }

  if (body.sampleId !== testKit.sampleId) {
    return { ok: false, message: 'Unknown compatibility sample.' };
  }

  if (typeof body.sampleSha256 === 'string' && body.sampleSha256 !== testKit.sha256) {
    return { ok: false, message: 'Compatibility sample checksum does not match.' };
  }

  if (!isCompatibilityOsName(body.osName)) {
    return { ok: false, message: 'Invalid OS name.' };
  }

  if (!isDownloadResult(body.downloadResult)) {
    return { ok: false, message: 'Invalid download result.' };
  }

  if (!isTransferPath(body.transferPath)) {
    return { ok: false, message: 'Invalid transfer path.' };
  }

  if (!Array.isArray(body.viewers) || body.viewers.length === 0 || body.viewers.length > 8) {
    return { ok: false, message: 'Viewer results are required.' };
  }

  const viewers: CompatibilityViewerReport[] = [];

  for (const viewer of body.viewers) {
    if (!isRecord(viewer) || !isViewerId(viewer.viewer) || !isViewerOutcome(viewer.outcome)) {
      return { ok: false, message: 'Invalid viewer result.' };
    }

    const nextViewer: CompatibilityViewerReport = {
      viewer: viewer.viewer,
      outcome: viewer.outcome,
    };
    const appVersion = cleanString(viewer.appVersion, 64);
    const note = cleanString(viewer.note, 240);

    if (appVersion) {
      nextViewer.appVersion = appVersion;
    }

    if (note) {
      nextViewer.note = note;
    }

    viewers.push(nextViewer);
  }

  const report: CompatibilityReportInput = {
    sampleId: testKit.sampleId,
    sampleSha256: testKit.sha256,
    osName: body.osName,
    downloadResult: body.downloadResult,
    transferPath: body.transferPath,
    viewers,
  };
  const deviceBrand = cleanString(body.deviceBrand, 80);
  const deviceModel = cleanString(body.deviceModel, 100);
  const osVersion = cleanString(body.osVersion, 80);
  const browserName = cleanString(body.browserName, 80);
  const browserVersion = cleanString(body.browserVersion, 80);
  const notes = cleanString(body.notes, 500);

  if (deviceBrand) {
    report.deviceBrand = deviceBrand;
  }

  if (deviceModel) {
    report.deviceModel = deviceModel;
  }

  if (osVersion) {
    report.osVersion = osVersion;
  }

  if (browserName) {
    report.browserName = browserName;
  }

  if (browserVersion) {
    report.browserVersion = browserVersion;
  }

  if (notes) {
    report.notes = notes;
  }

  return {
    ok: true,
    report,
  };
}

function inferConfidence(report: CompatibilityReportInput): CompatibilityConfidence {
  const hasActionableViewerResult = report.viewers.some((viewer) => viewer.outcome !== 'not-tested');
  const hasDeviceInfo = Boolean(report.deviceBrand || report.deviceModel || report.osVersion);

  if (!hasActionableViewerResult) {
    return 'D';
  }

  return hasDeviceInfo ? 'B' : 'C';
}

function createSummary(sampleId: string, reports: StoredCompatibilityReport[]): CompatibilitySummary {
  const publicReports = reports.map(stripPrivateReportFields);
  const viewerStats = createViewerStats(publicReports);
  const environmentStats = createEnvironmentStats(publicReports);

  return {
    sampleId,
    reportCount: publicReports.length,
    viewerStats,
    environmentStats,
    latestReports: publicReports.slice(-8).reverse(),
  };
}

function createViewerStats(reports: CompatibilityReport[]): CompatibilityViewerSummary[] {
  const stats = new Map<CompatibilityViewerId, CompatibilityViewerSummary>();

  for (const viewer of viewerIds) {
    stats.set(viewer, {
      viewer,
      total: 0,
      recognized: 0,
      still: 0,
      failed: 0,
      notTested: 0,
    });
  }

  for (const report of reports) {
    for (const viewer of report.viewers) {
      const summary = stats.get(viewer.viewer);

      if (!summary) {
        continue;
      }

      summary.total += 1;

      if (viewer.outcome === 'recognized') {
        summary.recognized += 1;
      } else if (viewer.outcome === 'still') {
        summary.still += 1;
      } else if (viewer.outcome === 'failed') {
        summary.failed += 1;
      } else {
        summary.notTested += 1;
      }
    }
  }

  return Array.from(stats.values()).filter((summary) => summary.total > 0);
}

function createEnvironmentStats(reports: CompatibilityReport[]): CompatibilityEnvironmentSummary[] {
  const stats = new Map<string, CompatibilityEnvironmentSummary>();

  for (const report of reports) {
    const key = [
      report.osName,
      report.osVersion ?? 'unknown',
      report.deviceBrand ?? 'unknown',
      report.deviceModel ?? 'unknown',
    ].join('|');
    const current =
      stats.get(key) ??
      createEnvironmentSummary({
        key,
        report,
      });

    current.total += 1;

    if (report.viewers.some((viewer) => viewer.outcome === 'recognized')) {
      current.recognized += 1;
    }

    if (report.viewers.some((viewer) => viewer.viewer === 'system-gallery' && viewer.outcome === 'still')) {
      current.hasSystemGalleryLimit = true;
    }

    stats.set(key, current);
  }

  return Array.from(stats.values()).sort((left, right) => right.total - left.total);
}

function createEnvironmentSummary(input: {
  key: string;
  report: CompatibilityReport;
}): CompatibilityEnvironmentSummary {
  const summary: CompatibilityEnvironmentSummary = {
    key: input.key,
    osName: input.report.osName,
    total: 0,
    recognized: 0,
    hasSystemGalleryLimit: false,
  };

  if (input.report.osVersion) {
    summary.osVersion = input.report.osVersion;
  }

  if (input.report.deviceBrand) {
    summary.deviceBrand = input.report.deviceBrand;
  }

  if (input.report.deviceModel) {
    summary.deviceModel = input.report.deviceModel;
  }

  return summary;
}

function createReportsCsv(reports: CompatibilityReport[]): string {
  const rows = [
    [
      'id',
      'createdAt',
      'confidence',
      'osName',
      'osVersion',
      'deviceBrand',
      'deviceModel',
      'browserName',
      'browserVersion',
      'downloadResult',
      'transferPath',
      'systemGallery',
      'googlePhotos',
      'douyin',
      'fileManager',
      'notes',
    ],
  ];

  for (const report of reports) {
    rows.push([
      report.id,
      report.createdAt,
      report.confidence,
      report.osName,
      report.osVersion ?? '',
      report.deviceBrand ?? '',
      report.deviceModel ?? '',
      report.browserName ?? '',
      report.browserVersion ?? '',
      report.downloadResult,
      report.transferPath,
      getViewerOutcome(report, 'system-gallery'),
      getViewerOutcome(report, 'google-photos'),
      getViewerOutcome(report, 'douyin'),
      getViewerOutcome(report, 'file-manager'),
      report.notes ?? '',
    ]);
  }

  return `${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
}

function getViewerOutcome(report: CompatibilityReport, viewer: CompatibilityViewerId): string {
  return report.viewers.find((item) => item.viewer === viewer)?.outcome ?? '';
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '""')}"`;
}

function stripPrivateReportFields(report: StoredCompatibilityReport): CompatibilityReport {
  const { ipHash: _ipHash, ...publicReport } = report;

  return publicReport;
}

function hashClientIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

function cleanString(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const cleaned = value.trim().replace(/\s+/g, ' ');

  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompatibilityOsName(value: unknown): value is CompatibilityOsName {
  return typeof value === 'string' && osNames.has(value as CompatibilityOsName);
}

function isDownloadResult(value: unknown): value is CompatibilityDownloadResult {
  return typeof value === 'string' && downloadResults.has(value as CompatibilityDownloadResult);
}

function isTransferPath(value: unknown): value is CompatibilityTransferPath {
  return typeof value === 'string' && transferPaths.has(value as CompatibilityTransferPath);
}

function isViewerId(value: unknown): value is CompatibilityViewerId {
  return typeof value === 'string' && viewerIds.has(value as CompatibilityViewerId);
}

function isViewerOutcome(value: unknown): value is CompatibilityViewerOutcome {
  return typeof value === 'string' && viewerOutcomes.has(value as CompatibilityViewerOutcome);
}

function isStoredReport(value: StoredCompatibilityReport): value is StoredCompatibilityReport {
  return Boolean(value.id && value.sampleId && value.createdAt && value.ipHash && Array.isArray(value.viewers));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
