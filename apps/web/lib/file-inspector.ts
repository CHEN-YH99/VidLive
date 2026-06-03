import { supportedInputs, type VideoMetadata } from '@vidlive/shared';

export function isSupportedInput(file: File): boolean {
  const extension = file.name.split('.').pop()?.toLowerCase();

  return supportedInputs.some((input) => {
    const extensionMatches = extension === input.extension;
    const mimeMatches = file.type.length > 0 && (input.mimeTypes as readonly string[]).includes(file.type);
    return extensionMatches || mimeMatches;
  });
}

export function inspectVideoFile(file: File, objectUrl: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      const metadata: VideoMetadata = {
        name: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'unknown',
        durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
        hasAudio: null,
      };

      cleanup();
      resolve(metadata);
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('metadata-read-failed'));
    };

    video.src = objectUrl;
  });
}

export function inspectImageLikeFile(file: File): VideoMetadata {
  return {
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type || 'unknown',
    durationSeconds: null,
    width: null,
    height: null,
    hasAudio: false,
  };
}

export function captureCoverFrame(videoUrl: string, seconds: number): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    if (!context) {
      resolve(null);
      return;
    }

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    video.onloadedmetadata = () => {
      const targetTime = Math.min(Math.max(seconds, 0), video.duration || 0);
      video.currentTime = targetTime;
    };

    video.onseeked = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      cleanup();
      resolve(canvas.toDataURL('image/jpeg', 0.84));
    };

    video.onerror = () => {
      cleanup();
      resolve(null);
    };

    video.src = videoUrl;
  });
}
