// Minimal store-only (uncompressed) ZIP reader/writer — enough to satisfy
// the manual's "Download Projects" / "Restore" requirement without pulling
// in a compression dependency; project data (raw PCM) barely compresses
// anyway. Implements just the subset of the ZIP format needed: local file
// headers, a central directory, and the end-of-central-directory record,
// all with compression method 0 (store).

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}
function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

const DOS_TIME = 0;
const DOS_DATE = 0b0000000000100001; // 1980-01-01, arbitrary fixed timestamp

export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0); // store
    writeUint16(localView, 10, DOS_TIME);
    writeUint16(localView, 12, DOS_DATE);
    writeUint32(localView, 14, crc);
    writeUint32(localView, 18, entry.data.length);
    writeUint32(localView, 22, entry.data.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    local.set(nameBytes, 30);

    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0); // store
    writeUint16(centralView, 12, DOS_TIME);
    writeUint16(centralView, 14, DOS_DATE);
    writeUint32(centralView, 16, crc);
    writeUint32(centralView, 20, entry.data.length);
    writeUint32(centralView, 24, entry.data.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, centralStart);

  return new Blob([...localParts, ...centralParts, end] as BlobPart[], { type: 'application/zip' });
}

/** Reads a store-only or DEFLATE-free ZIP's top-level entries (throws on compressed entries). */
export async function readZip(data: ArrayBuffer): Promise<ZipEntry[]> {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  // Locate the end-of-central-directory record by scanning from the tail
  // (it may be followed by a variable-length comment field).
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralStart = view.getUint32(eocdOffset + 16, true);

  let pos = centralStart;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));

    if (method !== 0) throw new Error(`Unsupported compression method for "${name}"`);

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: bytes.slice(dataStart, dataStart + compressedSize) });

    pos += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
