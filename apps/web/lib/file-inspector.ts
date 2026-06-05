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

export async function inspectMp4ContainerFile(file: File): Promise<VideoMetadata | null> {
  if (!isSupportedInput(file) || file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')) {
    return null;
  }

  const buffer = await file.arrayBuffer();
  const durationSeconds = readMp4DurationSeconds(new DataView(buffer));

  if (!durationSeconds) {
    return null;
  }

  return {
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type || 'video/unknown',
    durationSeconds,
    width: null,
    height: null,
    hasAudio: null,
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

interface Mp4Box {
  offset: number;
  size: number;
  headerSize: number;
}

function readMp4DurationSeconds(view: DataView): number | null {
  const moov = findMp4Box(view, 0, view.byteLength, 'moov');

  if (!moov) {
    return null;
  }

  const mvhd = findMp4Box(view, moov.offset + moov.headerSize, moov.offset + moov.size, 'mvhd');

  if (!mvhd || mvhd.offset + mvhd.size > view.byteLength) {
    return null;
  }

  const version = view.getUint8(mvhd.offset + mvhd.headerSize);

  if (version === 1) {
    const timescale = view.getUint32(mvhd.offset + mvhd.headerSize + 20);
    const duration = Number(view.getBigUint64(mvhd.offset + mvhd.headerSize + 24));
    return timescale > 0 && Number.isFinite(duration) ? duration / timescale : null;
  }

  const timescale = view.getUint32(mvhd.offset + mvhd.headerSize + 12);
  const duration = view.getUint32(mvhd.offset + mvhd.headerSize + 16);

  return timescale > 0 ? duration / timescale : null;
}

function findMp4Box(view: DataView, start: number, end: number, targetType: string): Mp4Box | null {
  let offset = start;

  while (offset + 8 <= end && offset + 8 <= view.byteLength) {
    const size32 = view.getUint32(offset);
    const type = readMp4BoxType(view, offset + 4);
    let size = size32;
    let headerSize = 8;

    if (size32 === 1) {
      if (offset + 16 > view.byteLength) {
        return null;
      }

      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }

    if (type === targetType) {
      return { offset, size, headerSize };
    }

    if (size < headerSize) {
      return null;
    }

    offset += size;
  }

  return null;
}

function readMp4BoxType(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}
