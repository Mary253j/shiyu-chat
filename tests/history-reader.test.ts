import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { parseHistory, parseHistoryFromReader, type HistoryReader } from '../src/core/history';
import { HISTORY_READ_CHUNK_SIZE, readHistoryRange, readHistoryText } from '../src/core/history-reader';

function readerOf(bytes: Uint8Array, shortRead = HISTORY_READ_CHUNK_SIZE): HistoryReader {
  return { size: bytes.length, async read(offset, length) {
    assert.ok(length <= HISTORY_READ_CHUNK_SIZE, 'a native read must never allocate the entire file');
    return bytes.slice(offset, offset + Math.min(length, shortRead));
  } };
}

test('chunked JSON decoding preserves emoji and Chinese crossing a native read boundary', async () => {
  const prefix = '[{"id":"legacy","title":"旧记录","messages":[{"role":"user","content":"';
  const text = `${prefix}${'a'.repeat(HISTORY_READ_CHUNK_SIZE - strToU8(prefix).length - 1)}😀中文结束"}]}]`;
  const bytes = strToU8(text);
  assert.equal(bytes[HISTORY_READ_CHUNK_SIZE - 1], 0xf0);
  let yields = 0;
  const parsed = await parseHistoryFromReader(readerOf(bytes, 137), 'history.json', { yieldControl: async () => { yields++; } });
  assert.deepEqual(parsed, parseHistory(text, 'history.json'));
  assert.ok(yields >= 3);
  assert.ok(parsed.conversations[0].messages[0].content.endsWith('😀中文结束'));
});

test('chunked decoder rejects invalid or truncated UTF-8 rather than substituting text', async () => {
  for (const tail of [[0xf0, 0x9f], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const bytes = new Uint8Array(HISTORY_READ_CHUNK_SIZE + tail.length);
    bytes.fill(0x61, 0, HISTORY_READ_CHUNK_SIZE);
    bytes.set(tail, HISTORY_READ_CHUNK_SIZE);
    await assert.rejects(readHistoryText(readerOf(bytes), '损坏文件'), /UTF-8/);
  }
});

test('range reader joins short reads but fails closed when source stops early or returns an oversized chunk', async () => {
  const bytes = new Uint8Array(70000).map((_value, index) => index % 251);
  assert.deepEqual(await readHistoryRange(readerOf(bytes, 91), 7, 68000), bytes.slice(7, 68007));
  await assert.rejects(readHistoryRange({ size: 10, read: async () => new Uint8Array() }, 0, 10), /读取不完整/);
  await assert.rejects(readHistoryRange({ size: 10, read: async () => new Uint8Array(11) }, 0, 10), /读取不完整/);
  await assert.rejects(readHistoryRange(readerOf(bytes), 69999, 2), /截断/);
});

test('reader import preserves native deletion revisions and boundaries without recreating removed text', async () => {
  const value = { schemaVersion: 1, conversations: [{ id: 'local', title: '保留', createdAt: 1, updatedAt: 3,
    redactionRevision: 2, messages: [{ id: 'remaining', role: 'assistant', content: '保留的回复', createdAt: 3,
      status: 'complete', contextBoundaryBefore: true, contextEligible: true }] }] };
  const bytes = strToU8(JSON.stringify(value));
  const parsed = await parseHistoryFromReader(readerOf(bytes, 3), 'backup.json');
  assert.deepEqual(parsed, parseHistory(bytes, 'backup.json'));
  assert.equal(parsed.conversations[0].redactionRevision, 2);
  assert.equal(parsed.conversations[0].messages[0].contextBoundaryBefore, true);
});

test('reader ZIP import retains exact original branches and unknown fields while selecting the active branch', async () => {
  const date = '2026-11-17T12:00:00.000Z';
  const message = (id: number, parent_id: number | null, role: string, content: string) => ({
    id, parent_id, role, status: 'FINISHED', inserted_at: date,
    fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
  });
  const raw = { id: 'one', title: '原会话', inserted_at: date, updated_at: date, current_message_id: 2,
    future: { exact: '别改动😀' }, messages: [message(1, null, 'USER', '之前的问题'), message(2, 1, 'ASSISTANT', '当前回答'), message(3, 1, 'ASSISTANT', '其他分支')] };
  const bytes = zipSync({
    'manifest.json': strToU8('\uFEFF{"export_format_version":3}'),
    'chat_sessions/one.json': strToU8(JSON.stringify(raw)),
    'chat_session_index.json': strToU8('[{"id":"one","message_count":3}]'),
  });
  const parsed = await parseHistoryFromReader(readerOf(bytes, 17), 'official.zip');
  assert.deepEqual(parsed, parseHistory(bytes, 'official.zip'));
  assert.deepEqual(parsed.conversations[0].originalData, raw);
  assert.deepEqual(parsed.conversations[0].messages.map(message => message.id), ['1', '2']);
  assert.ok(parsed.warnings.some(warning => warning.includes('其他分支')));
});

test('reader checks empty and oversize inputs before reading any file bytes', async () => {
  const never = async (): Promise<Uint8Array> => { throw new Error('must not read'); };
  await assert.rejects(parseHistoryFromReader({ size: 0, read: never }, 'empty.zip'), /文件为空/);
  await assert.rejects(parseHistoryFromReader({ size: 1024 ** 3 + 1, read: never }, 'large.zip'), /1 GB/);
});

test('native allocation failure while reading a ZIP entry is preserved for the memory guidance', async () => {
  const bytes = zipSync({ 'manifest.json': strToU8('{"export_format_version":3}') });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const failure = new Error('java.lang.OutOfMemoryError: Failed to allocate a byte allocation');
  const source: HistoryReader = { size: bytes.length, async read(offset, length) {
    if (offset === dataStart) throw failure;
    return bytes.slice(offset, offset + length);
  } };
  await assert.rejects(parseHistoryFromReader(source, 'official.zip'), error => error === failure);
});
