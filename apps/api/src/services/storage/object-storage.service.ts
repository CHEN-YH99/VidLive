import { createReadStream } from 'node:fs';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type ArtifactStorageProvider = 'local-temp-link' | 'r2-signed-url';

export interface ObjectStorageConfig {
  r2Endpoint: string | null;
  r2AccessKeyId: string | null;
  r2SecretAccessKey: string | null;
  r2Bucket: string | null;
  r2SignedUrlTtlSeconds: number;
}

export interface StoreArtifactInput {
  jobId: string;
  fileName: string;
  localPath: string;
  contentType: string;
}

export interface StoredArtifact {
  provider: ArtifactStorageProvider;
  downloadUrl: string;
  objectKey: string | null;
  signedUrlExpiresAt: string | null;
}

export class ObjectStorageService {
  private readonly s3Client: S3Client | null;
  private readonly bucket: string | null;

  constructor(private readonly config: ObjectStorageConfig) {
    this.bucket = config.r2Bucket;
    this.s3Client = isR2Configured(config)
      ? new S3Client({
          region: 'auto',
          endpoint: config.r2Endpoint!,
          credentials: {
            accessKeyId: config.r2AccessKeyId!,
            secretAccessKey: config.r2SecretAccessKey!,
          },
        })
      : null;
  }

  get provider(): ArtifactStorageProvider {
    return this.s3Client && this.bucket ? 'r2-signed-url' : 'local-temp-link';
  }

  async storeArtifact(input: StoreArtifactInput): Promise<StoredArtifact> {
    if (!this.s3Client || !this.bucket) {
      return {
        provider: 'local-temp-link',
        downloadUrl: `/api/conversions/cloud-jobs/${input.jobId}/download`,
        objectKey: null,
        signedUrlExpiresAt: null,
      };
    }

    const objectKey = `conversions/${input.jobId}/${input.fileName}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: createReadStream(input.localPath),
        ContentType: input.contentType,
      }),
    );

    const downloadUrl = await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
      {
        expiresIn: this.config.r2SignedUrlTtlSeconds,
      },
    );

    return {
      provider: 'r2-signed-url',
      downloadUrl,
      objectKey,
      signedUrlExpiresAt: new Date(Date.now() + this.config.r2SignedUrlTtlSeconds * 1000).toISOString(),
    };
  }

  async deleteArtifact(objectKey: string | null): Promise<void> {
    if (!this.s3Client || !this.bucket || !objectKey) {
      return;
    }

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
    );
  }
}

function isR2Configured(config: ObjectStorageConfig): boolean {
  return Boolean(config.r2Endpoint && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket);
}
