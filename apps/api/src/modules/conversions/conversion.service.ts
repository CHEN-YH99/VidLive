import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { ConversionDraft } from '@vidlive/shared';
import type { AppConfig } from '../../config/env.js';
import { LivePhotoService } from '../../services/live-photo/live-photo.service.js';
import type { ProbeResult } from '../../services/ffmpeg/ffmpeg.service.js';
import {
  ObjectStorageService,
  type ArtifactStorageProvider,
} from '../../services/storage/object-storage.service.js';

export type CloudConversionStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'expired' | 'deleted';
export type CloudQueueProvider = 'in-memory-beta' | 'redis-bullmq';

export interface CloudConversionArtifact {
  kind: 'package';
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
  deleteUrl: string;
  storageProvider: ArtifactStorageProvider;
  objectKey: string | null;
  signedUrlExpiresAt: string | null;
}

export interface CloudConversionDirectArtifact {
  kind: 'android-motion-photo' | 'preview-photo' | 'paired-video';
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
}

export interface CloudConversionJob {
  id: string;
  status: CloudConversionStatus;
  progress: number;
  draft: ConversionDraft;
  source: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  probe: ProbeResult | null;
  artifact: CloudConversionArtifact | null;
  androidMotionPhoto: CloudConversionDirectArtifact | null;
  previewPhoto: CloudConversionDirectArtifact | null;
  pairedVideo: CloudConversionDirectArtifact | null;
  warnings: string[];
  error: {
    code: string;
    message: string;
  } | null;
}

export interface CloudConversionMetrics {
  queueProvider: CloudQueueProvider;
  storageProvider: ArtifactStorageProvider;
  totals: Record<CloudConversionStatus, number>;
  queueCounts: Record<string, number> | null;
  activeJobs: number;
  lastUpdatedAt: string;
}

export interface CreateCloudJobInput {
  id?: string;
  sourcePath: string;
  workDir: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  draft: ConversionDraft;
  retentionHours: number;
}

interface CloudConversionJobRecord extends CloudConversionJob {
  sourcePath: string;
  workDir: string;
  zipPath: string | null;
  motionPhotoPath: string | null;
  previewPhotoPath: string | null;
  pairedVideoPath: string | null;
}

interface CloudQueueResult {
  probe: ProbeResult;
  warnings: string[];
  zipPath: string;
  artifact: CloudConversionArtifact;
  motionPhotoPath: string | null;
  androidMotionPhoto: CloudConversionDirectArtifact | null;
  previewPhotoPath: string | null;
  previewPhoto: CloudConversionDirectArtifact | null;
  pairedVideoPath: string | null;
  pairedVideo: CloudConversionDirectArtifact | null;
}

interface ConversionLogger {
  info: (payload: unknown, message?: string) => void;
  warn: (payload: unknown, message?: string) => void;
  error: (payload: unknown, message?: string) => void;
}

interface ConversionServiceOptions {
  config?: AppConfig;
  livePhotoService?: LivePhotoService;
  storageService?: ObjectStorageService;
  runBullMqWorker?: boolean;
  logger?: ConversionLogger;
}

const queueName = 'vidlive-cloud-conversions';

export class ConversionService {
  private readonly jobs = new Map<string, CloudConversionJobRecord>();
  private readonly livePhotoService: LivePhotoService;
  private readonly storageService: ObjectStorageService;
  private readonly logger: ConversionLogger | null;
  private readonly redisConnection: Redis | null;
  private readonly queue: Queue<CloudConversionJobRecord, CloudQueueResult, string> | null;
  private readonly worker: Worker<CloudConversionJobRecord, CloudQueueResult, string> | null;

  constructor(options: ConversionServiceOptions = {}) {
    this.livePhotoService = options.livePhotoService ?? new LivePhotoService();
    this.storageService = options.storageService ?? new ObjectStorageService(createStorageConfig(options.config));
    this.logger = options.logger ?? null;

    if (options.config?.redisUrl) {
      this.redisConnection = new Redis(options.config.redisUrl, {
        maxRetriesPerRequest: null,
      });
      this.redisConnection.on('error', (error) => {
        this.logger?.error({ error }, 'Redis connection error.');
      });
      this.queue = new Queue<CloudConversionJobRecord, CloudQueueResult, string>(queueName, {
        connection: this.redisConnection,
      });
      this.queue.on('error', (error) => {
        this.logger?.error({ error }, 'BullMQ queue error.');
      });
      this.worker =
        options.runBullMqWorker === false
          ? null
          : new Worker<CloudConversionJobRecord, CloudQueueResult, string>(
              queueName,
              (job) => this.processBullMqJob(job),
              {
                connection: this.redisConnection,
                concurrency: Math.max(1, options.config.cloudQueueConcurrency),
              },
            );

      this.worker?.on('failed', (job, error) => {
        this.logger?.error({ jobId: job?.id, error }, 'BullMQ cloud conversion job failed.');
      });
      this.worker?.on('error', (error) => {
        this.logger?.error({ error }, 'BullMQ worker error.');
      });
    } else {
      this.redisConnection = null;
      this.queue = null;
      this.worker = null;
    }
  }

  get queueProvider(): CloudQueueProvider {
    return this.queue ? 'redis-bullmq' : 'in-memory-beta';
  }

  get storageProvider(): ArtifactStorageProvider {
    return this.storageService.provider;
  }

  async createCloudJob(input: CreateCloudJobInput): Promise<CloudConversionJob> {
    this.cleanupExpiredJobs();

    const now = new Date();
    const id = input.id ?? randomUUID();
    const expiresAt = new Date(now.getTime() + input.retentionHours * 60 * 60 * 1000);
    const job: CloudConversionJobRecord = {
      id,
      status: 'queued',
      progress: 5,
      draft: input.draft,
      source: {
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      probe: null,
      artifact: null,
      androidMotionPhoto: null,
      previewPhoto: null,
      pairedVideo: null,
      warnings: [],
      error: null,
      sourcePath: input.sourcePath,
      workDir: input.workDir,
      zipPath: null,
      motionPhotoPath: null,
      previewPhotoPath: null,
      pairedVideoPath: null,
    };

    this.jobs.set(id, job);
    this.logger?.info({ jobId: id, queueProvider: this.queueProvider }, 'Cloud conversion job accepted.');

    if (this.queue) {
      try {
        await this.queue.add('convert-live-photo', job, {
          jobId: id,
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 2_000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        });
      } catch (error) {
        this.logger?.error({ jobId: id, error }, 'BullMQ enqueue failed, falling back to in-memory processing.');
        void this.processJob(id);
      }
    } else {
      void this.processJob(id);
    }

    return toPublicJob(job);
  }

  async getCloudJob(id: string): Promise<CloudConversionJob | null> {
    this.cleanupExpiredJobs();

    const queueJob = await this.getBullMqJob(id);

    if (queueJob) {
      return this.toPublicBullMqJob(queueJob);
    }

    const job = this.jobs.get(id);

    return job ? toPublicJob(job) : null;
  }

  async getDownload(id: string): Promise<{ path: string; fileName: string; sizeBytes: number } | null> {
    this.cleanupExpiredJobs();

    const job = this.jobs.get(id);
    const queueJob = await this.getBullMqJob(id);
    const queueResult = isCompletedQueueJob(queueJob) ? queueJob.returnvalue : null;
    const zipPath = job?.zipPath ?? queueResult?.zipPath ?? null;
    const artifact = job?.artifact ?? queueResult?.artifact ?? null;

    if (!zipPath || !artifact) {
      return null;
    }

    const fileStat = await stat(zipPath);

    return {
      path: zipPath,
      fileName: artifact.fileName,
      sizeBytes: fileStat.size,
    };
  }

  async getPreviewPhotoDownload(id: string): Promise<{ path: string; fileName: string; sizeBytes: number } | null> {
    this.cleanupExpiredJobs();

    const job = this.jobs.get(id);
    const queueJob = await this.getBullMqJob(id);
    const queueResult = isCompletedQueueJob(queueJob) ? queueJob.returnvalue : null;
    const previewPhotoPath = job?.previewPhotoPath ?? queueResult?.previewPhotoPath ?? null;
    const artifact = job?.previewPhoto ?? queueResult?.previewPhoto ?? null;

    if (!previewPhotoPath || !artifact) {
      return null;
    }

    const fileStat = await stat(previewPhotoPath);

    return {
      path: previewPhotoPath,
      fileName: artifact.fileName,
      sizeBytes: fileStat.size,
    };
  }

  async getPairedVideoDownload(id: string): Promise<{ path: string; fileName: string; sizeBytes: number } | null> {
    this.cleanupExpiredJobs();

    const job = this.jobs.get(id);
    const queueJob = await this.getBullMqJob(id);
    const queueResult = isCompletedQueueJob(queueJob) ? queueJob.returnvalue : null;
    const pairedVideoPath = job?.pairedVideoPath ?? queueResult?.pairedVideoPath ?? null;
    const artifact = job?.pairedVideo ?? queueResult?.pairedVideo ?? null;

    if (!pairedVideoPath || !artifact) {
      return null;
    }

    const fileStat = await stat(pairedVideoPath);

    return {
      path: pairedVideoPath,
      fileName: artifact.fileName,
      sizeBytes: fileStat.size,
    };
  }

  async getAndroidMotionPhotoDownload(id: string): Promise<{ path: string; fileName: string; sizeBytes: number } | null> {
    this.cleanupExpiredJobs();

    const job = this.jobs.get(id);
    const queueJob = await this.getBullMqJob(id);
    const queueResult = isCompletedQueueJob(queueJob) ? queueJob.returnvalue : null;
    const motionPhotoPath = job?.motionPhotoPath ?? queueResult?.motionPhotoPath ?? null;
    const artifact = job?.androidMotionPhoto ?? queueResult?.androidMotionPhoto ?? null;

    if (!motionPhotoPath || !artifact) {
      return null;
    }

    const fileStat = await stat(motionPhotoPath);

    return {
      path: motionPhotoPath,
      fileName: artifact.fileName,
      sizeBytes: fileStat.size,
    };
  }

  async deleteCloudJob(id: string): Promise<CloudConversionJob | null> {
    const queueJob = await this.getBullMqJob(id);
    const queueResult = isCompletedQueueJob(queueJob) ? queueJob.returnvalue : null;
    const job = this.jobs.get(id) ?? queueJob?.data ?? null;

    if (!job) {
      return null;
    }

    if (queueResult?.artifact && !job.artifact) {
      job.artifact = queueResult.artifact;
      job.zipPath = queueResult.zipPath;
    }

    if (queueResult?.androidMotionPhoto && !job.androidMotionPhoto) {
      job.androidMotionPhoto = queueResult.androidMotionPhoto;
      job.motionPhotoPath = queueResult.motionPhotoPath;
    }

    if (queueResult?.previewPhoto && !job.previewPhoto) {
      job.previewPhoto = queueResult.previewPhoto;
      job.previewPhotoPath = queueResult.previewPhotoPath;
    }

    if (queueResult?.pairedVideo && !job.pairedVideo) {
      job.pairedVideo = queueResult.pairedVideo;
      job.pairedVideoPath = queueResult.pairedVideoPath;
    }

    await this.removeJobFiles(job);
    job.status = 'deleted';
    job.progress = 100;
    job.updatedAt = new Date().toISOString();
    job.artifact = null;
    job.androidMotionPhoto = null;
    job.previewPhoto = null;
    job.pairedVideo = null;
    job.zipPath = null;
    job.motionPhotoPath = null;
    job.previewPhotoPath = null;
    job.pairedVideoPath = null;
    this.jobs.delete(id);
    await queueJob?.remove();
    this.logger?.info({ jobId: id }, 'Cloud conversion job deleted.');

    return toPublicJob(job);
  }

  async getMetrics(): Promise<CloudConversionMetrics> {
    this.cleanupExpiredJobs();

    const totals = createStatusTotals();

    for (const job of this.jobs.values()) {
      totals[job.status] += 1;
    }

    const queueCounts = this.queue
      ? await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')
      : null;

    return {
      queueProvider: this.queueProvider,
      storageProvider: this.storageProvider,
      totals,
      queueCounts,
      activeJobs: totals.queued + totals.processing + (queueCounts?.waiting ?? 0) + (queueCounts?.active ?? 0),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.redisConnection?.disconnect();
  }

  cleanupExpiredJobs(): void {
    const now = Date.now();

    for (const job of this.jobs.values()) {
      if (Date.parse(job.expiresAt) > now || job.status === 'deleted') {
        continue;
      }

      job.status = 'expired';
      job.progress = 100;
      job.updatedAt = new Date().toISOString();
      job.artifact = null;
      job.androidMotionPhoto = null;
      job.previewPhoto = null;
      job.pairedVideo = null;
      job.zipPath = null;
      job.motionPhotoPath = null;
      job.previewPhotoPath = null;
      job.pairedVideoPath = null;
      void this.removeJobFiles(job);
    }
  }

  private async getBullMqJob(id: string): Promise<Job<CloudConversionJobRecord, CloudQueueResult, string> | null> {
    return (this.queue ? await this.queue.getJob(id) : null) ?? null;
  }

  private async processJob(id: string): Promise<void> {
    const job = this.jobs.get(id);

    if (!job || job.status !== 'queued') {
      return;
    }

    try {
      await this.processJobRecord(job);
    } catch {
      // processJobRecord already persisted the failure on the job.
    }
  }

  private async processBullMqJob(job: Job<CloudConversionJobRecord, CloudQueueResult, string>): Promise<CloudQueueResult> {
    const record = this.jobs.get(job.data.id) ?? job.data;
    this.jobs.set(record.id, record);
    await job.updateProgress(25);
    const result = await this.processJobRecord(record);
    await job.updateProgress(100);

    return result;
  }

  private async processJobRecord(job: CloudConversionJobRecord): Promise<CloudQueueResult> {
    try {
      updateJob(job, {
        status: 'processing',
        progress: 25,
      });
      this.logger?.info({ jobId: job.id }, 'Cloud conversion job started.');

      const result = await this.livePhotoService.generate({
        sourcePath: job.sourcePath,
        workDir: path.join(job.workDir, 'result'),
        draft: job.draft,
      });
      const packageStat = await stat(result.zipPath);
      const fileName = `vidlive-beta-${job.id}.zip`;
      const storedArtifact = await this.storageService.storeArtifact({
        jobId: job.id,
        fileName,
        localPath: result.zipPath,
        contentType: 'application/zip',
      });
      const artifact: CloudConversionArtifact = {
        kind: 'package',
        fileName,
        sizeBytes: packageStat.size,
        downloadUrl: storedArtifact.downloadUrl,
        deleteUrl: `/api/conversions/cloud-jobs/${job.id}`,
        storageProvider: storedArtifact.provider,
        objectKey: storedArtifact.objectKey,
        signedUrlExpiresAt: storedArtifact.signedUrlExpiresAt,
      };
      const androidMotionPhoto: CloudConversionDirectArtifact | null = result.androidMotionPhotoPath
        ? {
            kind: 'android-motion-photo',
            fileName: 'motion-photo_MP.jpg',
            sizeBytes: (await stat(result.androidMotionPhotoPath)).size,
            downloadUrl: `/api/conversions/cloud-jobs/${job.id}/android-motion-photo`,
          }
        : null;
      const previewPhoto: CloudConversionDirectArtifact = {
        kind: 'preview-photo',
        fileName: 'photo.jpg',
        sizeBytes: (await stat(result.photoPath)).size,
        downloadUrl: `/api/conversions/cloud-jobs/${job.id}/preview-photo`,
      };
      const pairedVideo: CloudConversionDirectArtifact = {
        kind: 'paired-video',
        fileName: 'video.mov',
        sizeBytes: (await stat(result.movPath)).size,
        downloadUrl: `/api/conversions/cloud-jobs/${job.id}/paired-video`,
      };

      updateJob(job, {
        status: 'completed',
        progress: 100,
        probe: result.probe,
        warnings: result.warnings,
        zipPath: result.zipPath,
        motionPhotoPath: result.androidMotionPhotoPath,
        previewPhotoPath: result.photoPath,
        pairedVideoPath: result.movPath,
        artifact,
        androidMotionPhoto,
        previewPhoto,
        pairedVideo,
      });
      this.logger?.info(
        { jobId: job.id, storageProvider: artifact.storageProvider, sizeBytes: artifact.sizeBytes },
        'Cloud conversion job completed.',
      );

      return {
        probe: result.probe,
        warnings: result.warnings,
        zipPath: result.zipPath,
        artifact,
        motionPhotoPath: result.androidMotionPhotoPath,
        androidMotionPhoto,
        previewPhotoPath: result.photoPath,
        previewPhoto,
        pairedVideoPath: result.movPath,
        pairedVideo,
      };
    } catch (error) {
      updateJob(job, {
        status: 'failed',
        progress: 100,
        error: {
          code: 'cloud-conversion-failed',
          message: error instanceof Error ? error.message : '云端安卓实况图生成失败。',
        },
      });
      this.logger?.error({ jobId: job.id, error }, 'Cloud conversion job failed.');
      throw error;
    }
  }

  private async removeJobFiles(job: CloudConversionJobRecord): Promise<void> {
    await this.storageService.deleteArtifact(job.artifact?.objectKey ?? null);
    await rm(job.workDir, { recursive: true, force: true });
  }

  private async toPublicBullMqJob(
    queueJob: Job<CloudConversionJobRecord, CloudQueueResult, string>,
  ): Promise<CloudConversionJob> {
    const state = await queueJob.getState();
    const record = this.jobs.get(queueJob.data.id) ?? queueJob.data;
    const status = mapBullMqStateToStatus(state, record);
    const result = status === 'completed' ? queueJob.returnvalue : null;
    const progress = typeof queueJob.progress === 'number' ? queueJob.progress : record.progress;

    return toPublicJob({
      ...record,
      status,
      progress,
      probe: result?.probe ?? record.probe,
      warnings: result?.warnings ?? record.warnings,
      artifact: result?.artifact ?? record.artifact,
      androidMotionPhoto: result?.androidMotionPhoto ?? record.androidMotionPhoto,
      previewPhoto: result?.previewPhoto ?? record.previewPhoto,
      pairedVideo: result?.pairedVideo ?? record.pairedVideo,
      zipPath: result?.zipPath ?? record.zipPath,
      motionPhotoPath: result?.motionPhotoPath ?? record.motionPhotoPath,
      previewPhotoPath: result?.previewPhotoPath ?? record.previewPhotoPath,
      pairedVideoPath: result?.pairedVideoPath ?? record.pairedVideoPath,
      error:
        status === 'failed'
          ? {
              code: 'cloud-conversion-failed',
              message: queueJob.failedReason || record.error?.message || '云端安卓实况图生成失败。',
            }
          : record.error,
    });
  }
}

function createStorageConfig(config: AppConfig | undefined) {
  return {
    r2Endpoint: config?.r2Endpoint ?? null,
    r2AccessKeyId: config?.r2AccessKeyId ?? null,
    r2SecretAccessKey: config?.r2SecretAccessKey ?? null,
    r2Bucket: config?.r2Bucket ?? null,
    r2SignedUrlTtlSeconds: config?.r2SignedUrlTtlSeconds ?? 60 * 60,
  };
}

function createStatusTotals(): Record<CloudConversionStatus, number> {
  return {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    expired: 0,
    deleted: 0,
  };
}

function updateJob(job: CloudConversionJobRecord, update: Partial<CloudConversionJobRecord>): void {
  Object.assign(job, update, {
    updatedAt: new Date().toISOString(),
  });
}

function toPublicJob(job: CloudConversionJobRecord): CloudConversionJob {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    draft: job.draft,
    source: job.source,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    probe: job.probe,
    artifact: job.artifact,
    androidMotionPhoto: job.androidMotionPhoto,
    previewPhoto: job.previewPhoto,
    pairedVideo: job.pairedVideo,
    warnings: job.warnings,
    error: job.error,
  };
}

function isCompletedQueueJob(
  queueJob: Job<CloudConversionJobRecord, CloudQueueResult, string> | null,
): queueJob is Job<CloudConversionJobRecord, CloudQueueResult, string> & { returnvalue: CloudQueueResult } {
  return Boolean(queueJob?.returnvalue);
}

function mapBullMqStateToStatus(state: string, record: CloudConversionJobRecord): CloudConversionStatus {
  if (Date.parse(record.expiresAt) <= Date.now()) {
    return 'expired';
  }

  if (state === 'completed') {
    return 'completed';
  }

  if (state === 'failed') {
    return 'failed';
  }

  if (state === 'active') {
    return 'processing';
  }

  return record.status === 'deleted' ? 'deleted' : 'queued';
}
