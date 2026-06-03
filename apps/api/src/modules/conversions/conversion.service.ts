import type { ConversionDraft, VideoMetadata } from '@vidlive/shared';

export interface CloudConversionIntent {
  id: string;
  draft: ConversionDraft;
  metadata: VideoMetadata;
  expiresAt: Date;
}

export class ConversionService {
  createCloudIntent(_draft: ConversionDraft, _metadata: VideoMetadata): CloudConversionIntent {
    throw new Error('cloud-processing-not-enabled');
  }
}
