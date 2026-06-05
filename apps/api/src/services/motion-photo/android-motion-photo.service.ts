import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export interface AndroidMotionPhotoInput {
  photoPath: string;
  videoPath: string;
  outputPath: string;
  presentationTimestampUs: number;
}

export interface AndroidMotionPhotoResult {
  path: string;
  videoLengthBytes: number;
  xmpInjected: boolean;
}

const execFileAsync = promisify(execFile);

export class AndroidMotionPhotoService {
  async generate(input: AndroidMotionPhotoInput): Promise<AndroidMotionPhotoResult> {
    await mkdir(path.dirname(input.outputPath), { recursive: true });

    const videoStat = await stat(input.videoPath);
    const videoLengthBytes = videoStat.size;
    const xmpPath = path.join(path.dirname(input.outputPath), 'motion-photo.xmp');
    const basePhotoPath = path.join(path.dirname(input.outputPath), 'motion-photo-base.jpg');
    const xmp = createMotionPhotoXmp({
      presentationTimestampUs: input.presentationTimestampUs,
      videoLengthBytes,
    });

    await copyFile(input.photoPath, basePhotoPath);
    await writeFile(xmpPath, xmp);

    try {
      await execFileAsync('exiftool', ['-overwrite_original', `-XMP<=${xmpPath}`, basePhotoPath]);
    } catch {
      const sourcePhoto = await readFile(input.photoPath);
      await writeFile(basePhotoPath, injectXmpIntoJpeg(sourcePhoto, xmp));
    }

    const [photoBuffer, videoBuffer] = await Promise.all([readFile(basePhotoPath), readFile(input.videoPath)]);

    await writeFile(input.outputPath, Buffer.concat([photoBuffer, videoBuffer]));

    return {
      path: input.outputPath,
      videoLengthBytes,
      xmpInjected: true,
    };
  }
}

function injectXmpIntoJpeg(jpegBuffer: Buffer, xmp: string): Buffer {
  if (jpegBuffer.length < 4 || jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) {
    throw new Error('motion-photo-xmp-injection-requires-jpeg');
  }

  const xmpHeader = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'utf8');
  const xmpPayload = Buffer.concat([xmpHeader, Buffer.from(xmp, 'utf8')]);
  const segmentLength = xmpPayload.length + 2;

  if (segmentLength > 0xffff) {
    throw new Error('motion-photo-xmp-too-large');
  }

  const app1Marker = Buffer.alloc(4);
  app1Marker[0] = 0xff;
  app1Marker[1] = 0xe1;
  app1Marker.writeUInt16BE(segmentLength, 2);

  const insertOffset = findJpegMetadataInsertOffset(jpegBuffer);

  return Buffer.concat([
    jpegBuffer.subarray(0, insertOffset),
    app1Marker,
    xmpPayload,
    jpegBuffer.subarray(insertOffset),
  ]);
}

function findJpegMetadataInsertOffset(jpegBuffer: Buffer): number {
  let offset = 2;

  while (offset + 4 < jpegBuffer.length && jpegBuffer[offset] === 0xff) {
    const marker = jpegBuffer[offset + 1];

    if (typeof marker !== 'number') {
      break;
    }

    if (marker < 0xe0 || marker > 0xef) {
      break;
    }

    const segmentLength = jpegBuffer.readUInt16BE(offset + 2);

    if (segmentLength < 2) {
      break;
    }

    offset += 2 + segmentLength;
  }

  return offset;
}

function createMotionPhotoXmp(input: { presentationTimestampUs: number; videoLengthBytes: number }): string {
  const timestamp = Math.max(0, Math.round(input.presentationTimestampUs));

  return [
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description',
    '      xmlns:Camera="http://ns.google.com/photos/1.0/camera/"',
    '      xmlns:Container="http://ns.google.com/photos/1.0/container/"',
    '      xmlns:Item="http://ns.google.com/photos/1.0/container/item/"',
    '      Camera:MotionPhoto="1"',
    '      Camera:MotionPhotoVersion="1"',
    `      Camera:MotionPhotoPresentationTimestampUs="${timestamp}"`,
    '      Camera:MicroVideo="1"',
    '      Camera:MicroVideoVersion="1"',
    `      Camera:MicroVideoOffset="${input.videoLengthBytes}"`,
    `      Camera:MicroVideoPresentationTimestampUs="${timestamp}">`,
    '      <Container:Directory>',
    '        <rdf:Seq>',
    '          <rdf:li rdf:parseType="Resource">',
    '            <Container:Item',
    '              Item:Mime="image/jpeg"',
    '              Item:Semantic="Primary"',
    '              Item:Length="0"',
    '              Item:Padding="0" />',
    '          </rdf:li>',
    '          <rdf:li rdf:parseType="Resource">',
    '            <Container:Item',
    '              Item:Mime="video/mp4"',
    '              Item:Semantic="MotionPhoto"',
    `              Item:Length="${input.videoLengthBytes}"`,
    '              Item:Padding="0" />',
    '          </rdf:li>',
    '        </rdf:Seq>',
    '      </Container:Directory>',
    '    </rdf:Description>',
    '  </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
    '',
  ].join('\n');
}
