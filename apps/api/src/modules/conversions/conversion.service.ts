import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConversionDraft } from '@vidlive/shared';
import { LivePhotoService } from '../../services/live-photo/live-photo.service.js';
import type { ProbeResult } from '../../services/ffmpeg/ffmpeg.service.js';

export type CloudConversionStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'expired' | 'deleted';

export interface CloudConversionArtifact {
  kind: 'package';
  fileName: string;
  sizeBytes: number;
  downloadUrl: string;
  deleteUrl: string;
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
  warnings: string[];
  error: {
    code: string;
    message: string;
  } | null;
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
}

export class ConversionService {
  private readonly jobs = new Map<string, CloudConversionJobRecord>();

  constructor(private readonly livePhotoService = new LivePhotoService()) {}

  createCloudJob(input: CreateCloudJobInput): CloudConversionJob {
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
      warnings: [],
      error: null,
      sourcePath: input.sourcePath,
      workDir: input.workDir,
      zipPath: null,
    };

    this.jobs.set(id, job);
    void this.processJob(id);

    return toPublicJob(job);
  }

  getCloudJob(id: string): CloudConversionJob | null {
    this.cleanupExpiredJobs();

    const job = this.jobs.get(id);

    return job ? toPublicJob(job) : null;
  }

  async getDownload(id: string): Promise<{ path: string; fileName: string; sizeBytes: number } | null> {
    this.cleanupExpiredJobs();

    const job = this.jobs.get(id);

    if (!job || job.status !== 'completed' || !job.zipPath || !job.artifact) {
      return null;
    }

    const fileStat = await stat(job.zipPath);

    return {
      path: job.zipPath,
      fileName: job.artifact.fileName,
      sizeBytes: fileStat.size,
    };
  }

  async deleteCloudJob(id: string): Promise<CloudConversionJob | null> {
    const job = this.jobs.get(id);

    if (!job) {
      return null;
    }

    await this.removeJobFiles(job);
    job.status = 'deleted';
    job.progress = 100;
    job.updatedAt = new Date().toISOString();
    job.artifact = null;
    job.zipPath = null;
    this.jobs.delete(id);

    return toPublicJob(job);
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
      job.zipPath = null;
      void this.removeJobFiles(job);
    }
  }

  private async processJob(id: string): Promise<void> {
    const job = this.jobs.get(id);

    if (!job || job.status !== 'queued') {
      return;
    }

    try {
      updateJob(job, {
        status: 'processing',
        progress: 25,
      });

      const result = await this.livePhotoService.generate({
        sourcePath: job.sourcePath,
        workDir: path.join(job.workDir, 'result'),
        draft: job.draft,
      });
      const packageStat = await stat(result.zipPath);

      updateJob(job, {
        status: 'completed',
        progress: 100,
        probe: result.probe,
        warnings: result.warnings,
        zipPath: result.zipPath,
        artifact: {
          kind: 'package',
          fileName: `vidlive-beta-${job.id}.zip`,
          sizeBytes: packageStat.size,
          downloadUrl: `/api/conversions/cloud-jobs/${job.id}/download`,
          deleteUrl: `/api/conversions/cloud-jobs/${job.id}`,
        },
      });
    } catch (error) {
      updateJob(job, {
        status: 'failed',
        progress: 100,
        error: {
          code: 'cloud-conversion-failed',
          message: error instanceof Error ? error.message : 'Cloud conversion failed.',
        },
      });
    }
  }

  private async removeJobFiles(job: CloudConversionJobRecord): Promise<void> {
    await rm(job.workDir, { recursive: true, force: true });
  }
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
    warnings: job.warnings,
    error: job.error,
  };
}
