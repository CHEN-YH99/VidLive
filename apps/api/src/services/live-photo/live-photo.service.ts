import type { ConversionDraft } from '@vidlive/shared';

export interface LivePhotoGenerateInput {
  sourcePath: string;
  workDir: string;
  draft: ConversionDraft;
}

export interface LivePhotoGenerateResult {
  photoPath: string;
  movPath: string;
  zipPath: string;
}

export class LivePhotoService {
  async generate(_input: LivePhotoGenerateInput): Promise<LivePhotoGenerateResult> {
    throw new Error('live-photo-generation-not-implemented');
  }
}
