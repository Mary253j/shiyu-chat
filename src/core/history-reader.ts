import { Inflate, strFromU8, strToU8 } from 'fflate';
import { checkHistoryInputSize, HISTORY_FILE_LIMIT_LABEL } from './history-limits';

/** Every read is bounded; the Android adapter must not call File.bytes(). */
export const HISTORY_READ_CHUNK_SIZE = 64 * 1024;
export interface HistoryReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export interface HistoryReadProgress {
  phase: 'reading' | 'checking' | 'parsing';
  completed: number;
  total: number;
}
export interface HistoryReadOptions {
  onProgress?: (progress: HistoryReadProgress) => void;
  yieldControl?: () => Promise<void>;
}
export interface HistoryZipEntry {
  name: string;
  compressed: number;
  expanded: number;
  crc: number;
  method: number;
  flags: number;
  offset: number;
  dataStart: number;
}

function fail(message: string): never { throw new Error(`无法导入：${message}`); }
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Allocation failures are not evidence that the user's archive is corrupt. */
export function isHistoryMemoryError(error: unknown): boolean {
  return /out\s*of\s*memory|failed to allocate|allocation failed|invalid (?:string|array(?: buffer)?) length|java heap space/i
    .test(error instanceof Error ? error.message : String(error));
}

/** Handles short reads without ever asking the native layer for a large buffer. */
export async function readHistoryRange(reader: HistoryReader, offset: number, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || offset + length > reader.size) fail('文件内容已截断。');
  if (length === 0) return new Uint8Array();
  let result: Uint8Array | undefined;
  let written = 0;
  while (written < length) {
    const wanted = Math.min(HISTORY_READ_CHUNK_SIZE, length - written);
    const chunk = await reader.read(offset + written, wanted);
    if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > wanted) fail('文件读取不完整。');
    if (written === 0 && chunk.length === length) return chunk;
    result ??= new Uint8Array(length);
    result.set(chunk, written); written += chunk.length;
  }
  return result!;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  // fflate's platform TextDecoder strips an initial BOM. Preserve it here,
  // including a real U+FEFF that happens to land at an incremental boundary.
  let start = 0;
  while (bytes[start] === 0xef && bytes[start + 1] === 0xbb && bytes[start + 2] === 0xbf) start += 3;
  const value = '\uFEFF'.repeat(start / 3) + strFromU8(bytes.subarray(start));
  const encoded = strToU8(value);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) fail(`${label}不是有效 UTF-8。`);
  return value;
}

/** Keep at most three UTF-8 continuation bytes between chunks. */
class Utf8Chunks {
  private carry = new Uint8Array();
  private parts: string[] = [];
  constructor(private label: string) {}
  push(chunk: Uint8Array, final = false): void {
    let bytes = chunk;
    if (this.carry.length) {
      bytes = new Uint8Array(this.carry.length + chunk.length);
      bytes.set(this.carry); bytes.set(chunk, this.carry.length);
    }
    let end = bytes.length;
    if (!final && end) {
      let lead = end - 1;
      while (lead > 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
      const value = bytes[lead];
      const expected = (value & 0xf8) === 0xf0 ? 4 : (value & 0xf0) === 0xe0 ? 3 : (value & 0xe0) === 0xc0 ? 2 : 1;
      if (end - lead < expected) end = lead;
    }
    if (end) this.parts.push(decodeUtf8(bytes.subarray(0, end), this.label));
    this.carry = bytes.slice(end);
  }
  finish(): string {
    this.push(new Uint8Array(), true);
    const result = this.parts.join('');
    this.parts = [];
    return result;
  }
}

export async function readHistoryText(reader: HistoryReader, label: string, options: HistoryReadOptions = {}): Promise<string> {
  const text = new Utf8Chunks(label);
  for (let offset = 0; offset < reader.size; offset += HISTORY_READ_CHUNK_SIZE) {
    text.push(await readHistoryRange(reader, offset, Math.min(HISTORY_READ_CHUNK_SIZE, reader.size - offset)));
    options.onProgress?.({ phase: 'reading', completed: Math.min(offset + HISTORY_READ_CHUNK_SIZE, reader.size), total: reader.size });
    await options.yieldControl?.();
  }
  return text.finish();
}

function safePath(value: string): string {
  const normalized = value.normalize('NFC');
  if (!normalized || normalized.includes('\\') || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) fail('ZIP 包含不安全的文件路径。');
  const parts = normalized.split('/');
  if (parts.some((part, index) => part === '.' || part === '..' || (!part && index !== parts.length - 1))) fail('ZIP 包含不安全的文件路径。');
  return normalized;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[index] = value >>> 0;
}

/**
 * Inspect the directory and local headers before touching entry payloads. Only
 * names and numeric metadata are retained; neither the ZIP nor attachment bytes
 * are loaded as a whole. Each requested JSON is decoded and released separately.
 */
export async function openHistoryZip(reader: HistoryReader, limits: { entries: number; expandedBytes: number }, options: HistoryReadOptions = {}) {
  checkHistoryInputSize(reader.size);
  const tailOffset = Math.max(0, reader.size - 65557);
  const tail = await readHistoryRange(reader, tailOffset, reader.size - tailOffset);
  const tailView = viewOf(tail);
  let endInTail = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tailView.getUint32(at, true) === 0x06054b50 && at + 22 + tailView.getUint16(at + 20, true) === tail.length) { endInTail = at; break; }
  }
  if (endInTail < 0) fail('ZIP 包不完整。');
  const end = tailOffset + endInTail;
  const count = tailView.getUint16(endInTail + 10, true);
  const directorySize = tailView.getUint32(endInTail + 12, true);
  const directory = tailView.getUint32(endInTail + 16, true);
  if (tailView.getUint16(endInTail + 4, true) || tailView.getUint16(endInTail + 6, true) || tailView.getUint16(endInTail + 8, true) !== count) fail('不支持分卷 ZIP。');
  if (count === 65535 || directory === 0xffffffff || directorySize === 0xffffffff) fail('不支持 ZIP64。');
  if (count > limits.entries) fail('ZIP 内文件数量过多。');
  if (directory + directorySize !== end) fail('ZIP 目录已损坏。');
  const entries: HistoryZipEntry[] = []; const seen = new Set<string>();
  let at = directory; let expandedTotal = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end) fail('ZIP 目录已损坏。');
    const header = viewOf(await readHistoryRange(reader, at, 46));
    if (header.getUint32(0, true) !== 0x02014b50) fail('ZIP 目录已损坏。');
    const nameLength = header.getUint16(28, true); const extra = header.getUint16(30, true); const comment = header.getUint16(32, true);
    if (at + 46 + nameLength + extra + comment > end) fail('ZIP 文件名已损坏。');
    const name = safePath(decodeUtf8(await readHistoryRange(reader, at + 46, nameLength), 'ZIP 文件名'));
    const entry: HistoryZipEntry = { name, flags: header.getUint16(8, true), method: header.getUint16(10, true), crc: header.getUint32(16, true),
      compressed: header.getUint32(20, true), expanded: header.getUint32(24, true), offset: header.getUint32(42, true), dataStart: 0 };
    if (entry.flags & 1 || entry.flags & 0x40) fail('不支持加密 ZIP。');
    if (entry.method !== 0 && entry.method !== 8) fail('不支持该 ZIP 压缩方式。');
    if (header.getUint16(34, true) || [entry.compressed, entry.expanded, entry.offset].includes(0xffffffff)) fail('不支持 ZIP64 或分卷 ZIP。');
    if (seen.has(name)) fail(`ZIP 出现重复路径：${name}`);
    seen.add(name); expandedTotal += entry.expanded;
    if (expandedTotal > limits.expandedBytes) fail(`解压后的总大小超过 ${HISTORY_FILE_LIMIT_LABEL}。`);
    entries.push(entry); at += 46 + nameLength + extra + comment;
    if (index % 32 === 31) await options.yieldControl?.();
  }
  if (at !== end) fail('ZIP 目录长度不匹配。');
  entries.sort((a, b) => a.offset - b.offset);
  if (entries[0]?.name !== 'manifest.json' || entries[0].offset !== 0) fail('ZIP 首个文件必须为 manifest.json。');
  let previousEnd = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]; const offset = entry.offset;
    if (offset !== previousEnd || offset + 30 > directory) fail('ZIP 本地文件头已损坏、缺失或重叠。');
    const local = viewOf(await readHistoryRange(reader, offset, 30));
    if (local.getUint32(0, true) !== 0x04034b50) fail('ZIP 本地文件头已损坏、缺失或重叠。');
    const nameLength = local.getUint16(26, true); const extraLength = local.getUint16(28, true);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (dataStart + entry.compressed > directory) fail('ZIP 文件内容已截断。');
    const name = safePath(decodeUtf8(await readHistoryRange(reader, offset + 30, nameLength), 'ZIP 文件名'));
    if (name !== entry.name || local.getUint16(8, true) !== entry.method || local.getUint16(6, true) !== entry.flags) fail('ZIP 文件头与目录不一致。');
    if (!(entry.flags & 8) && (local.getUint32(14, true) !== entry.crc || local.getUint32(18, true) !== entry.compressed || local.getUint32(22, true) !== entry.expanded)) fail('ZIP 文件大小或校验信息不一致。');
    if (entry.method === 0 && entry.compressed !== entry.expanded) fail('ZIP 未压缩文件大小不一致。');
    entry.dataStart = dataStart; previousEnd = dataStart + entry.compressed;
    if (entry.flags & 8) {
      if (previousEnd + 12 > directory) fail('ZIP 数据描述符已截断。');
      let descriptor = viewOf(await readHistoryRange(reader, previousEnd, 12));
      if (descriptor.getUint32(0, true) === 0x08074b50) {
        previousEnd += 4;
        if (previousEnd + 12 > directory) fail('ZIP 数据描述符已截断。');
        descriptor = viewOf(await readHistoryRange(reader, previousEnd, 12));
      }
      if (descriptor.getUint32(0, true) !== entry.crc || descriptor.getUint32(4, true) !== entry.compressed || descriptor.getUint32(8, true) !== entry.expanded) fail('ZIP 数据描述符与目录不一致。');
      previousEnd += 12;
    }
    if (index % 32 === 31) await options.yieldControl?.();
  }
  if (previousEnd !== directory) fail('ZIP 包含未记录的文件数据。');

  let checkedBytes = 0;
  const compressedTotal = entries.reduce((sum, entry) => sum + entry.compressed, 0);
  const verified = new Set<HistoryZipEntry>();
  async function consume(entry: HistoryZipEntry, collectText: boolean): Promise<string | undefined> {
    if (!entries.includes(entry)) fail('ZIP 文件索引无效。');
    const text = collectText ? new Utf8Chunks(entry.name) : undefined;
    let written = 0; let crc = 0xffffffff; let yieldedAt = 0;
    const consumeChunk = (chunk: Uint8Array) => {
      if (written + chunk.length > entry.expanded) fail('ZIP 实际解压大小超过声明，已停止导入。');
      written += chunk.length;
      for (let i = 0; i < chunk.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ chunk[i]) & 255];
      text?.push(chunk);
    };
    const inflater = entry.method === 8 ? new Inflate(consumeChunk) : undefined;
    try {
      if (!entry.compressed) inflater?.push(new Uint8Array(), true);
      for (let offset = 0; offset < entry.compressed; offset += HISTORY_READ_CHUNK_SIZE) {
        const chunk = await readHistoryRange(reader, entry.dataStart + offset, Math.min(HISTORY_READ_CHUNK_SIZE, entry.compressed - offset));
        if (inflater) {
          // A tiny DEFLATE input slice also bounds high-ratio attachment output.
          // The inflater keeps only its sliding window between callbacks.
          for (let part = 0; part < chunk.length; part += 1024) {
            const length = Math.min(1024, chunk.length - part);
            inflater.push(chunk.subarray(part, part + length), offset + part + length === entry.compressed);
            if (written - yieldedAt >= 1024 * 1024) {
              await options.yieldControl?.();
              yieldedAt = written;
            }
          }
        } else consumeChunk(chunk);
        if (!verified.has(entry)) checkedBytes += chunk.length;
        options.onProgress?.({ phase: 'checking', completed: checkedBytes, total: compressedTotal });
        await options.yieldControl?.();
      }
    } catch (error) {
      if (isHistoryMemoryError(error)) throw error;
      if (error instanceof Error && error.message.startsWith('无法导入：')) throw error;
      fail('ZIP 读取或压缩内容已损坏。');
    }
    if (written !== entry.expanded) fail('ZIP 解压后的文件大小不一致。');
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail(`ZIP 文件校验失败：${entry.name}`);
    verified.add(entry);
    return text?.finish();
  }
  return {
    entries,
    readText: (entry: HistoryZipEntry) => consume(entry, true) as Promise<string>,
    verify: async (entry: HistoryZipEntry) => { if (!verified.has(entry)) await consume(entry, false); },
  };
}
