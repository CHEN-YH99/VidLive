export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
}

export interface ClipOptions {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  muted: boolean;
}

export class FfmpegService {
  async probe(_filePath: string): Promise<ProbeResult> {
    throw new Error('ffmpeg-probe-not-implemented');
  }

  async clipToMov(_options: ClipOptions): Promise<string> {
    throw new Error('ffmpeg-clip-not-implemented');
  }
}
