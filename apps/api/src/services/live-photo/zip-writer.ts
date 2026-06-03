import { readFile, writeFile } from 'node:fs/promises';

export interface ZipSourceFile {
  sourcePath: string;
  entryName: string;
}

interface ZipEntryData {
  entryName: string;
  nameBuffer: Buffer;
  data: Buffer;
  crc: number;
  dosTime: number;
  dosDate: number;
  localHeaderOffset: number;
}

export async function createStoreZip(files: ZipSourceFile[], outputPath: string): Promise<string> {
  const entries: ZipEntryData[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const data = await readFile(file.sourcePath);
    const nameBuffer = Buffer.from(file.entryName, 'utf8');
    const crc = crc32(data);
    const { dosTime, dosDate } = toDosDateTime(new Date());
    const localHeader = createLocalFileHeader(nameBuffer.length, crc, data.length, dosTime, dosDate);

    entries.push({
      entryName: file.entryName,
      nameBuffer,
      data,
      crc,
      dosTime,
      dosDate,
      localHeaderOffset: offset,
    });
    localParts.push(localHeader, nameBuffer, data);
    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralParts = entries.flatMap((entry) => [
    createCentralDirectoryHeader(
      entry.nameBuffer.length,
      entry.crc,
      entry.data.length,
      entry.dosTime,
      entry.dosDate,
      entry.localHeaderOffset,
    ),
    entry.nameBuffer,
  ]);
  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endRecord = createEndOfCentralDirectory(entries.length, centralSize, centralOffset);

  await writeFile(outputPath, Buffer.concat([...localParts, ...centralParts, endRecord]));
  return outputPath;
}

function createLocalFileHeader(
  fileNameLength: number,
  crc: number,
  size: number,
  dosTime: number,
  dosDate: number,
): Buffer {
  const buffer = Buffer.alloc(30);

  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(dosTime, 10);
  buffer.writeUInt16LE(dosDate, 12);
  buffer.writeUInt32LE(crc, 14);
  buffer.writeUInt32LE(size, 18);
  buffer.writeUInt32LE(size, 22);
  buffer.writeUInt16LE(fileNameLength, 26);
  buffer.writeUInt16LE(0, 28);

  return buffer;
}

function createCentralDirectoryHeader(
  fileNameLength: number,
  crc: number,
  size: number,
  dosTime: number,
  dosDate: number,
  localHeaderOffset: number,
): Buffer {
  const buffer = Buffer.alloc(46);

  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE(20, 4);
  buffer.writeUInt16LE(20, 6);
  buffer.writeUInt16LE(0, 8);
  buffer.writeUInt16LE(0, 10);
  buffer.writeUInt16LE(dosTime, 12);
  buffer.writeUInt16LE(dosDate, 14);
  buffer.writeUInt32LE(crc, 16);
  buffer.writeUInt32LE(size, 20);
  buffer.writeUInt32LE(size, 24);
  buffer.writeUInt16LE(fileNameLength, 28);
  buffer.writeUInt16LE(0, 30);
  buffer.writeUInt16LE(0, 32);
  buffer.writeUInt16LE(0, 34);
  buffer.writeUInt16LE(0, 36);
  buffer.writeUInt32LE(0, 38);
  buffer.writeUInt32LE(localHeaderOffset, 42);

  return buffer;
}

function createEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  const buffer = Buffer.alloc(22);

  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(entryCount, 8);
  buffer.writeUInt16LE(entryCount, 10);
  buffer.writeUInt32LE(centralSize, 12);
  buffer.writeUInt32LE(centralOffset, 16);
  buffer.writeUInt16LE(0, 20);

  return buffer;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosTime, dosDate };
}

const crcTable = createCrcTable();

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  }

  return (crc ^ 0xffffffff) >>> 0;
}
