import assert from 'node:assert/strict';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate';
import { parseHistory, parseHistoryFromReader } from '../src/core/history';

const READ_LIMIT = 64 * 1024;
const ATTACHMENT_SIZE = 52 * 1024 * 1024;
const date = '2026-11-17T12:00:00.000Z';
const attachmentName = 'chat_sessions/range-review_files/large-synthetic.bin';

// This fixture is built on disk. Neither its writer nor its reader creates an
// archive-sized ArrayBuffer, which would mask the original File.bytes problem.
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[i] = value >>> 0;
}
function updateCrc(crc: number, chunk: Uint8Array): number {
  for (let i = 0; i < chunk.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ chunk[i]) & 255];
  return crc;
}

async function writeAll(file: FileHandle, data: Uint8Array): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const result = await file.write(data, written, data.length - written);
    assert.ok(result.bytesWritten > 0, 'fixture writer must make progress');
    written += result.bytesWritten;
  }
}

function reviewSession(attachmentSize = ATTACHMENT_SIZE) {
  return {
    id: 'range-review', title: '范围读取回归', inserted_at: date, updated_at: date, current_message_id: 2,
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: date,
        thinking_enabled: false, search_enabled: false, accumulated_token_usage: 0,
        fragments: [{ type: 'REQUEST', content: '请记住大附件之外的这条消息。' },
          { type: 'FILE', files: [{ id: 'large-synthetic', file_name: 'large-synthetic.bin', file_size: attachmentSize,
            export_path: attachmentName, is_image: false }] }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: date,
        thinking_enabled: false, search_enabled: false, accumulated_token_usage: 0,
        fragments: [{ type: 'RESPONSE', content: '这是仍然需要完整保留的回复。' }] },
    ],
  };
}

function smallEntries(attachmentSize = 4) {
  const session = reviewSession(attachmentSize);
  return {
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_session_index.json': strToU8(JSON.stringify([{ id: session.id, message_count: session.messages.length }])),
    [`chat_sessions/${session.id}.json`]: strToU8(JSON.stringify(session)),
    [attachmentName]: Uint8Array.of(1, 3, 5, 7),
  };
}

function memoryReader(bytes: Uint8Array) {
  return { size: bytes.length, async read(offset: number, length: number) {
    assert.ok(length > 0 && length <= READ_LIMIT);
    assert.ok(offset >= 0 && offset + length <= bytes.length);
    return bytes.slice(offset, offset + length);
  } };
}

function centralOffset(bytes: Uint8Array, index: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = view.getUint32(bytes.length - 6, true);
  for (let i = 0; i < index; i++) position += 46 + view.getUint16(position + 28, true)
    + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
  return position;
}

function descriptorArchive() {
  const chunks: Uint8Array[] = [];
  const archive = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  for (const [name, bytes] of Object.entries(smallEntries())) {
    const file = new ZipDeflate(name);
    archive.add(file);
    file.push(bytes, true);
  }
  archive.end();
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
  return result;
}

test('stream review: bounded reader matches existing official importer for stored, deflated and descriptor archives', async () => {
  for (const bytes of [zipSync(smallEntries(), { level: 0 }), zipSync(smallEntries()), descriptorArchive()]) {
    assert.deepEqual(await parseHistoryFromReader(memoryReader(bytes), 'synthetic.zip'), parseHistory(bytes, 'synthetic.zip'));
  }
});

test('stream review: range reads retain path, header overlap and descriptor checks', async () => {
  const unsafe = zipSync({ ...smallEntries(), '../escape.json': strToU8('{}') });
  await assert.rejects(() => parseHistoryFromReader(memoryReader(unsafe), 'unsafe.zip'), /不安全/);

  const overlap = zipSync(smallEntries());
  const view = new DataView(overlap.buffer, overlap.byteOffset, overlap.byteLength);
  view.setUint32(centralOffset(overlap, 1) + 42, 1, true);
  await assert.rejects(() => parseHistoryFromReader(memoryReader(overlap), 'overlap.zip'), /文件头|重叠|缺失/);

  const descriptor = descriptorArchive();
  const dv = new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength);
  const firstDescriptor = 30 + dv.getUint16(26, true) + dv.getUint16(28, true)
    + dv.getUint32(centralOffset(descriptor, 0) + 20, true);
  descriptor[firstDescriptor + 4] ^= 1;
  await assert.rejects(() => parseHistoryFromReader(memoryReader(descriptor), 'descriptor.zip'), /描述符/);
});

test('stream review: high-ratio DEFLATE attachments are checked without retaining expanded bytes', async () => {
  const expandedSize = 8 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  const archive = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  const repeated = new Uint8Array(READ_LIMIT);
  for (const [name, bytes] of Object.entries(smallEntries(expandedSize))) {
    const file = new ZipDeflate(name);
    archive.add(file);
    if (name === attachmentName) {
      for (let offset = 0; offset < expandedSize; offset += repeated.length) {
        file.push(repeated, offset + repeated.length === expandedSize);
      }
    } else file.push(bytes, true);
  }
  archive.end();
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  assert.ok(bytes.length < READ_LIMIT, 'the compressed input is much smaller than the expanded attachment');
  const result = await parseHistoryFromReader(memoryReader(bytes), 'compressed-attachment.zip');
  assert.equal(result.messageCount, 2);
  assert.deepEqual(result.conversations[0].originalData, reviewSession(expandedSize));
  assert.ok(JSON.stringify(result).length < 10_000);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const central = centralOffset(bytes, 3);
  const local = view.getUint32(central + 42, true);
  const descriptor = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    + view.getUint32(central + 20, true);
  const falseCrc = (view.getUint32(central + 16, true) ^ 1) >>> 0;
  // Keep the directory and descriptor consistent, so only checking the actual
  // expanded payload can reject this archive.
  view.setUint32(central + 16, falseCrc, true);
  view.setUint32(descriptor + 4, falseCrc, true);
  await assert.rejects(() => parseHistoryFromReader(memoryReader(bytes), 'bad-compressed-crc.zip'), /校验失败/);
});

async function writeLargeArchive(file: FileHandle) {
  const session = reviewSession();
  const smallEntries = [
    ['manifest.json', JSON.stringify({ export_format_version: 3 })],
    ['chat_session_index.json', JSON.stringify([{ id: session.id, title: session.title, message_count: session.messages.length }])],
    [`chat_sessions/${session.id}.json`, JSON.stringify(session)],
  ] as const;
  const repeated = Uint8Array.from({ length: READ_LIMIT }, (_, i) => i & 255);
  const entries = [
    ...smallEntries.map(([name, text]) => ({ name, bytes: Buffer.from(text), length: Buffer.byteLength(text) })),
    { name: attachmentName, bytes: repeated, length: ATTACHMENT_SIZE },
  ];
  const central: Buffer[] = [];
  let offset = 0;
  let attachmentStart = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x808, 6); // UTF-8 name and streaming data descriptor.
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    await writeAll(file, local);
    const localStart = offset;
    offset += local.length;
    if (entry.name === attachmentName) attachmentStart = offset;
    let crc = 0xffffffff;
    for (let position = 0; position < entry.length; position += READ_LIMIT) {
      const chunk = entry.bytes.subarray(0, Math.min(READ_LIMIT, entry.length - position));
      crc = updateCrc(crc, chunk);
      await writeAll(file, chunk);
      offset += chunk.length;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(entry.length, 8);
    descriptor.writeUInt32LE(entry.length, 12);
    await writeAll(file, descriptor);
    offset += descriptor.length;

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x808, 8);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(entry.length, 20);
    header.writeUInt32LE(entry.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(localStart, 42);
    name.copy(header, 46);
    central.push(header);
  }
  const centralStart = offset;
  for (const header of central) { await writeAll(file, header); offset += header.length; }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  await writeAll(file, end);
  return { size: offset + end.length, attachmentStart, session };
}

test('stream review: a 52 MiB disk ZIP uses bounded reads and still checks discarded attachment CRC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-range-import-'));
  const path = join(directory, 'synthetic-52m.zip');
  const file = await open(path, 'wx+');
  try {
    const fixture = await writeLargeArchive(file);
    assert.ok(fixture.size > ATTACHMENT_SIZE);
    assert.ok(fixture.size < ATTACHMENT_SIZE + READ_LIMIT);
    let largestRead = 0;
    let readCount = 0;
    let attachmentBytesRead = 0;
    let yields = 0;
    const progressPhases = new Set<string>();
    const reader = {
      size: fixture.size,
      async read(offset: number, length: number) {
        assert.ok(Number.isSafeInteger(offset) && offset >= 0);
        assert.ok(Number.isSafeInteger(length) && length > 0 && length <= READ_LIMIT,
          `every native-style read must stay at or below ${READ_LIMIT} bytes, got ${length}`);
        assert.ok(offset + length <= fixture.size);
        largestRead = Math.max(largestRead, length);
        readCount++;
        attachmentBytesRead += Math.max(0, Math.min(offset + length, fixture.attachmentStart + ATTACHMENT_SIZE)
          - Math.max(offset, fixture.attachmentStart));
        const bytes = Buffer.allocUnsafe(length);
        const result = await file.read(bytes, 0, length, offset);
        assert.equal(result.bytesRead, length);
        return bytes;
      },
    };
    const preview = await parseHistoryFromReader(reader, 'synthetic-52m.zip', {
      yieldControl: async () => { yields++; },
      onProgress: progress => { progressPhases.add(progress.phase); },
    });
    assert.equal(preview.conversations.length, 1);
    assert.equal(preview.messageCount, 2);
    assert.equal(preview.conversations[0].messages[0].content, '请记住大附件之外的这条消息。');
    assert.equal(preview.conversations[0].messages[1].content, '这是仍然需要完整保留的回复。');
    assert.deepEqual(preview.conversations[0].originalData, fixture.session);
    assert.ok(JSON.stringify(preview).length < 10_000, 'attachment bytes must never become retained preview data');
    assert.ok(largestRead <= READ_LIMIT);
    assert.ok(readCount > ATTACHMENT_SIZE / READ_LIMIT, 'the large payload must be processed as many bounded reads');
    assert.ok(attachmentBytesRead >= ATTACHMENT_SIZE, 'skipping attachment retention must not skip its CRC validation');
    assert.ok(yields > 1, 'large input must yield to the UI between bounded work');
    assert.ok(progressPhases.size > 0, 'large input must report progress');

    // Corruption near the end makes a reader that simply seeks over attachments
    // fail this regression. No existing user records are supplied or modified.
    const lastByte = (ATTACHMENT_SIZE - 1) & 255;
    await file.write(Uint8Array.of(lastByte ^ 1), 0, 1, fixture.attachmentStart + ATTACHMENT_SIZE - 1);
    await assert.rejects(() => parseHistoryFromReader(reader, 'corrupted-attachment.zip'), /校验失败/);
  } finally {
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
});
