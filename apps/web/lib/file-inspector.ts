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
    let timeoutId: number | null = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

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

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('metadata-read-failed'));
    }, 10_000);

    video.src = objectUrl;
    video.load();
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
    let settled = false;
    let timeoutId: number | null = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      video.removeAttribute('src');
      video.load();
    };

    const finish = (frameUrl: string | null) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(frameUrl);
    };

    if (!context) {
      resolve(null);
      return;
    }

    const drawFrame = () => {
      if (!video.videoWidth || !video.videoHeight) {
        finish(null);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL('image/jpeg', 0.84));
    };

    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      const targetTime = Math.min(Math.max(seconds, 0), video.duration || 0);

      if (targetTime <= 0.05) {
        if (video.readyState >= 2) {
          drawFrame();
        } else {
          video.onloadeddata = drawFrame;
        }
        return;
      }

      try {
        video.currentTime = targetTime;
      } catch {
        video.onloadeddata = drawFrame;
      }
    };

    video.onseeked = drawFrame;

    video.onerror = () => {
      finish(null);
    };

    timeoutId = window.setTimeout(() => {
      finish(null);
    }, 10_000);

    video.src = videoUrl;
    video.load();
  });
}
