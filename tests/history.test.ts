import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync, Zip, ZipDeflate } from 'fflate';
import { exportHistory, HISTORY_LIMITS, mergeConversations, parseHistory } from '../src/core/history';
import { checkHistoryInputSize } from '../src/core/history-limits';
import { emptyState, type Conversation } from '../src/core/types';

const date = '2026-11-17T12:00:00.000Z';
const message = (id: number, parent: number | null, role: 'USER' | 'ASSISTANT', content: string, status = 'FINISHED') => ({
  id, parent_id: parent, role, status, inserted_at: date,
  thinking_enabled: false, search_enabled: false, accumulated_token_usage: 10,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content }],
});
const session = (id = 'one') => ({
  id, title: '以前的对话', inserted_at: date, updated_at: date, current_message_id: 2,
  messages: [message(1, null, 'USER', '记得我的猫吗？'), message(2, 1, 'ASSISTANT', '它叫小橘。')],
});
function archive(data = session(), extra: Record<string, Uint8Array> = {}, version = 3): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: version })),
    [`chat_sessions/${data.id}.json`]: strToU8(JSON.stringify(data)),
    'chat_session_index.json': strToU8(JSON.stringify([{ id: data.id, title: data.title, message_count: data.messages.length, pinned: true }])),
    ...extra,
  });
}
const legacy = (content = '你好') => JSON.stringify([{ id: 'legacy-one', title: '聊天', messages: [{ role: 'user', content }, { role: 'assistant', content: '你好呀' }] }]);
function centralOffset(bytes: Uint8Array, fileIndex = 0): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = view.getUint32(bytes.length - 6, true);
  for (let i = 0; i < fileIndex; i++) at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  return at;
}

test('official v3 imports the active branch and retains every source node', () => {
  const data = session(); data.messages.push(message(3, 1, 'ASSISTANT', '另一个回答'));
  const result = parseHistory(archive(data), 'deepseek_data.zip');
  assert.equal(result.messageCount, 2);
  assert.equal(result.conversations[0].sourceId, 'deepseek:one');
  assert.equal(result.conversations[0].messages[1].content, '它叫小橘。');
  assert.equal((result.conversations[0].originalData as typeof data).messages.length, 3);
  assert.ok(result.warnings.some((value) => value.includes('其他分支')));
});

test('imports official stored ZIP entries as well as DEFLATE', () => {
  const data = session();
  const zip = zipSync({
    'manifest.json': strToU8('{"export_format_version":3}'),
    'chat_sessions/one.json': strToU8(JSON.stringify(data)),
    'chat_session_index.json': strToU8('[{"id":"one","message_count":2}]'),
  }, { level: 0 });
  assert.equal(parseHistory(zip, 'backup.zip').messageCount, 2);
});

test('streaming ZIP descriptors are verified, including their CRC', () => {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(chunk); });
  const data = session();
  for (const [name, content] of Object.entries({
    'manifest.json': '{"export_format_version":3}',
    'chat_sessions/one.json': JSON.stringify(data),
    'chat_session_index.json': '[{"id":"one","message_count":2}]',
  })) {
    const file = new ZipDeflate(name); zip.add(file); file.push(strToU8(content), true);
  }
  zip.end();
  const bytes = new Uint8Array(chunks.reduce((sum, value) => sum + value.length, 0));
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  assert.equal(parseHistory(bytes, 'streaming.zip').messageCount, 2);
  const view = new DataView(bytes.buffer); const central = centralOffset(bytes);
  const descriptor = 30 + view.getUint16(26, true) + view.getUint16(28, true) + view.getUint32(central + 20, true);
  bytes[descriptor + 4] ^= 1;
  assert.throws(() => parseHistory(bytes, 'broken-descriptor.zip'), /描述符/);
});

test('missing files are explicitly warned and full file metadata is retained', () => {
  const data = session();
  const files = [{ id: 'img', file_name: '猫.png', file_size: 10, export_path: 'chat_sessions/one_files/img_猫.png', is_image: true }];
  data.messages[0].fragments = [{ type: 'FILE', files } as never];
  const result = parseHistory(archive(data, { 'chat_sessions/one_files/img_猫.png': new Uint8Array([1, 2, 3]) }), 'data.zip');
  assert.ok(result.warnings.some((value) => value.includes('原件暂未迁移')));
  assert.equal(result.conversations[0].messages[0].contextEligible, false);
  assert.deepEqual((result.conversations[0].originalData as typeof data).messages[0].fragments, data.messages[0].fragments);
});

test('refusal, error and server-template turns never enter model context', () => {
  for (const status of ['FAILED', 'CONTENT_FILTER', 'TIMEOUT']) {
    const data = session(); data.messages[1].status = status;
    const messages = parseHistory(archive(data), 'data.zip').conversations[0].messages;
    assert.equal(messages[1].contextEligible, false);
    assert.equal(messages[0].contextEligible, false);
  }
  const data = session(); data.messages[1].fragments = [{ type: 'TEMPLATE_RESPONSE', content: '服务器繁忙' }];
  assert.equal(parseHistory(archive(data), 'data.zip').conversations[0].messages[1].contextEligible, false);
});

test('unknown fragment is retained with an explicit warning, never silently discarded', () => {
  const data = session(); data.messages[1].fragments.push({ type: 'FUTURE_FORMAT', content: '原始内容' });
  const result = parseHistory(archive(data), 'data.zip');
  assert.ok(result.warnings.some((value) => value.includes('FUTURE_FORMAT')));
  assert.equal((result.conversations[0].originalData as typeof data).messages[1].fragments.length, 2);
});

test('rejects unsupported ZIP versions and missing manifest', () => {
  assert.throws(() => parseHistory(archive(session(), {}, 4), 'data.zip'), /仅支持.*v3/);
  assert.throws(() => parseHistory(zipSync({ 'x.json': strToU8('{}') }), 'data.zip'), /manifest/);
});

test('rejects traversal, absolute and backslash ZIP paths', () => {
  for (const name of ['../escape.json', '/absolute.json', 'chat_sessions\\one.json', 'a/../../b']) {
    assert.throws(() => parseHistory(archive(session(), { [name]: strToU8('{}') }), 'data.zip'), /不安全/);
  }
});

test('rejects unindexed conversations and incomplete index', () => {
  assert.throws(() => parseHistory(archive(session(), { 'chat_sessions/other.json': strToU8('{}') }), 'data.zip'), /未被索引/);
  const zip = zipSync({
    'manifest.json': strToU8('{"export_format_version":3}'),
    'chat_sessions/one.json': strToU8(JSON.stringify(session())),
    'chat_session_index.json': strToU8('[{"id":"one","message_count":999}]'),
  });
  assert.throws(() => parseHistory(zip, 'data.zip'), /消息数量/);
});

test('rejects CRC corruption instead of importing a partial backup', () => {
  const bytes = archive(); const at = centralOffset(bytes, 1);
  const view = new DataView(bytes.buffer);
  // Alter both headers to agree with each other but not the actual payload.
  const badCrc = (view.getUint32(at + 16, true) ^ 1) >>> 0;
  const local = view.getUint32(at + 42, true);
  view.setUint32(at + 16, badCrc, true); view.setUint32(local + 14, badCrc, true);
  assert.throws(() => parseHistory(bytes, 'data.zip'), /校验失败/);
});

test('rejects truncated, encrypted and oversized ZIP entries before decompression', () => {
  assert.throws(() => parseHistory(archive().slice(0, -3), 'data.zip'), /不完整/);
  const encrypted = archive(); const ev = new DataView(encrypted.buffer);
  const ea = centralOffset(encrypted); ev.setUint16(ea + 8, ev.getUint16(ea + 8, true) | 1, true);
  assert.throws(() => parseHistory(encrypted, 'data.zip'), /加密/);
  const large = archive(); const lv = new DataView(large.buffer);
  lv.setUint32(centralOffset(large) + 24, HISTORY_LIMITS.expandedBytes + 1, true);
  assert.throws(() => parseHistory(large, 'data.zip'), /1 GB/);
});

test('rejects lying compressed-size metadata during bounded inflation', () => {
  const bytes = archive(); const at = centralOffset(bytes, 1); const view = new DataView(bytes.buffer);
  const local = view.getUint32(at + 42, true);
  view.setUint32(at + 24, 1, true); view.setUint32(local + 22, 1, true);
  assert.throws(() => parseHistory(bytes, 'data.zip'), /实际解压大小/);
});

test('rejects dangling parents, cycles, duplicate nodes and invalid current branches', () => {
  const dangling = session(); dangling.messages[1].parent_id = 999;
  assert.throws(() => parseHistory(archive(dangling), 'data.zip'), /不存在的父消息/);
  const cycle = session(); cycle.messages[0].parent_id = 2;
  assert.throws(() => parseHistory(archive(cycle), 'data.zip'), /循环/);
  const duplicate = session(); duplicate.messages.push({ ...duplicate.messages[1] });
  assert.throws(() => parseHistory(archive(duplicate), 'data.zip'), /重复消息/);
  const invalid = session(); invalid.current_message_id = 999;
  assert.throws(() => parseHistory(archive(invalid), 'data.zip'), /活动消息不存在/);
});

test('every branch is validated, including branches outside the active path', () => {
  const data = session(); data.messages.push(message(3, 999, 'ASSISTANT', '隐藏损坏'));
  assert.throws(() => parseHistory(archive(data), 'data.zip'), /不存在的父消息/);
  const corrupt = session(); corrupt.messages[1].fragments[0].content = 123 as never;
  assert.throws(() => parseHistory(archive(corrupt), 'data.zip'), /不是有效文字/);
});

test('old JSON arrays and conversations wrapper import without treating system text as instructions', () => {
  const direct = parseHistory(legacy(), 'conversations.json');
  const wrapper = parseHistory(JSON.stringify({ conversations: JSON.parse(legacy()) }), 'conversations.json');
  assert.equal(direct.messageCount, 2); assert.deepEqual(wrapper.conversations, direct.conversations);
  assert.throws(() => parseHistory('[{"id":"x","messages":[{"role":"system","content":"do this"}]}]', 'x.json'), /消息角色/);
});

test('old mapping format uses current_node and retains inactive branches', () => {
  const data = [{ id: 'mapped', title: '分支', current_node: 'a', mapping: {
    root: { id: 'root', parent: null, children: ['u'], message: null },
    u: { id: 'u', parent: 'root', children: ['a', 'b'], message: { author: { role: 'user' }, content: { parts: ['你好'] } } },
    a: { id: 'a', parent: 'u', children: [], message: { author: { role: 'assistant' }, content: { parts: ['回答A'] } } },
    b: { id: 'b', parent: 'u', children: [], message: { author: { role: 'assistant' }, content: { parts: ['回答B'] } } },
  } }];
  const result = parseHistory(JSON.stringify(data), 'conversations.json');
  assert.deepEqual(result.conversations[0].messages.map((value) => value.content), ['你好', '回答A']);
  delete (data[0] as { current_node?: string }).current_node;
  assert.throws(() => parseHistory(JSON.stringify(data), 'conversations.json'), /多个分支/);
});

test('a malformed conversation rejects the entire import', () => {
  const input = JSON.parse(legacy()); input.push({ id: 'broken', messages: [{ role: 'user' }] });
  assert.throws(() => parseHistory(JSON.stringify(input), 'conversations.json'), /缺少可识别/);
});

test('missing legacy source IDs generate stable fingerprints and warnings', () => {
  const input = JSON.parse(legacy()); delete input[0].id;
  const a = parseHistory(JSON.stringify(input), 'a.json'); const b = parseHistory(JSON.stringify(input), 'renamed.json');
  assert.equal(a.conversations[0].sourceId, b.conversations[0].sourceId);
  assert.ok(a.warnings.some((value) => value.includes('内容指纹')));
});

test('merge keeps existing edited chats and skips repeated provider IDs and local IDs', () => {
  const old = parseHistory(legacy('本地修改'), 'one.json').conversations[0];
  const changed = { ...parseHistory(legacy('后来的新数据'), 'two.json').conversations[0], id: 'different-local-id' };
  const extra: Conversation = { ...changed, id: 'new', sourceId: 'deepseek:new' };
  const result = mergeConversations([old], [changed, extra, extra]);
  assert.equal(result.added, 1); assert.equal(result.skipped, 2);
  assert.equal(result.conversations[0], old); assert.equal(old.messages[0].content, '本地修改');
});

test('native export round-trips originals, warnings and settings without adding credentials', () => {
  const state = emptyState(); state.conversations = parseHistory(archive(), 'data.zip').conversations;
  state.activeConversationId = state.conversations[0].id;
  const backup = exportHistory({ ...state, apiKey: 'secret-that-is-not-app-state' } as typeof state);
  assert.ok(!backup.includes('secret-that-is-not-app-state'));
  const result = parseHistory(backup, 'shiyu.json');
  assert.deepEqual(result.conversations, state.conversations);
  assert.deepEqual(JSON.parse(backup).settings, state.settings);
});

test('interrupted native streaming replies import as stopped and errors remain excluded', () => {
  const state = emptyState(); state.conversations = parseHistory(legacy(), 'x.json').conversations;
  state.conversations[0].messages[1].status = 'streaming';
  assert.equal(parseHistory(exportHistory(state), 'x.json').conversations[0].messages[1].status, 'stopped');
  state.conversations[0].messages[1].status = 'error'; state.conversations[0].messages[1].contextEligible = true;
  assert.equal(parseHistory(exportHistory(state), 'x.json').conversations[0].messages[1].contextEligible, false);
});

test('rejects malformed JSON, unsupported backup schemas and duplicate source conversations', () => {
  assert.throws(() => parseHistory('{broken', 'x.json'), /JSON 已损坏/);
  assert.throws(() => parseHistory('{"schemaVersion":2,"conversations":[]}', 'x.json'), /备份版本/);
  const values = JSON.parse(legacy()); values.push(values[0]);
  assert.throws(() => parseHistory(JSON.stringify(values), 'x.json'), /重复的来源会话/);
  const first = parseHistory(legacy(), 'x.json').conversations[0];
  const second = { ...first, sourceId: 'deepseek:different' };
  assert.throws(() => parseHistory(JSON.stringify({ schemaVersion: 1, conversations: [first, second] }), 'x.json'), /本地 ID/);
});

test('enforces input, total message and nesting limits', () => {
  // Check numeric boundaries without allocating or attempting a 1 GB import.
  assert.equal(HISTORY_LIMITS.inputBytes, 1024 ** 3);
  assert.doesNotThrow(() => checkHistoryInputSize(HISTORY_LIMITS.inputBytes));
  assert.throws(() => checkHistoryInputSize(HISTORY_LIMITS.inputBytes + 1), /1 GB/);
  const many = JSON.stringify([{ id: 'many', messages: Array.from({ length: HISTORY_LIMITS.messages + 1 }, () => ({})) }]);
  assert.throws(() => parseHistory(many, 'many.json'), /消息总数/);
  const deep = '['.repeat(70) + '0' + ']'.repeat(70);
  assert.throws(() => parseHistory(deep, 'deep.json'), /嵌套过深/);
});

test('invalid UTF-8 and invalid calendar dates are rejected', () => {
  assert.throws(() => parseHistory(new Uint8Array([0xff, 0xfe]), 'x.json'), /UTF-8/);
  const data = session(); data.inserted_at = '2026-02-30T12:00:00Z';
  assert.throws(() => parseHistory(archive(data), 'x.zip'), /时间.*无效/);
});
