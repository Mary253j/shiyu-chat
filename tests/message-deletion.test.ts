import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { buildContextPlan } from '../src/core/context';
import { exportHistory, parseHistory } from '../src/core/history';
import { deleteConversationMessages, ORIGINAL_DATA_REMOVED_WARNING } from '../src/core/message-deletion';
import { defaultSettings, emptyState, type Conversation, type Message } from '../src/core/types';

const message = (id: string, role: Message['role'], extra: Partial<Message> = {}): Message => ({
  id, role, content: id, createdAt: 1, status: 'complete', ...extra,
});
const user = (id: string, extra: Partial<Message> = {}) => message(id, 'user', extra);
const assistant = (id: string, extra: Partial<Message> = {}) => message(id, 'assistant', extra);
const conversation = (messages: Message[], extra: Partial<Conversation> = {}): Conversation => ({
  id: 'conversation', title: '聊天', createdAt: 1, updatedAt: 1, messages, ...extra,
});
const request = (value: Conversation) => buildContextPlan([...value.messages, user('now')], defaultSettings).messages;
const contents = (value: Conversation) => request(value).map(item => item.content);
const exportOne = (value: Conversation) => exportHistory({ ...emptyState(), conversations: [value], activeConversationId: value.id });
const roundTrip = (value: Conversation) => parseHistory(exportOne(value), 'app.json').conversations[0];
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('deleting only a selected user keeps unselected messages and prevents an earlier user from pairing with its answer', () => {
  const source = deepFreeze(conversation([user('u1'), user('u2'), assistant('a2')]));
  const result = deleteConversationMessages(source, ['u2'], 123);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.originalDataDropped, false);
  assert.deepEqual(result.conversation.messages.map(item => item.id), ['u1', 'a2']);
  assert.equal(result.conversation.messages[0], source.messages[0]);
  assert.equal(result.conversation.messages[1].contextBoundaryBefore, true);
  assert.deepEqual(contents(result.conversation), ['u1', 'now']);
  assert.equal(result.conversation.updatedAt, 123);
  assert.equal(result.conversation.redactionRevision, 1);
  assert.equal(source.messages.length, 3);
});

test('repeated deletion propagates a removed boundary to the next survivor', () => {
  const source = conversation([user('u1'), assistant('a1'), user('u2'), assistant('a2')]);
  const first = deleteConversationMessages(source, ['a1'], 2).conversation;
  assert.equal(first.messages[1].contextBoundaryBefore, true);
  const second = deleteConversationMessages(first, ['u2'], 3).conversation;
  assert.equal(second.messages[1].contextBoundaryBefore, true);
  assert.equal(second.redactionRevision, 2);
  assert.deepEqual(contents(second), ['u1', 'now']);
  assert.equal(source.messages[2].contextBoundaryBefore, undefined);
});

test('start, tail, duplicate selections, all, and no-op deletion have precise counts and revision behavior', () => {
  const source = deepFreeze(conversation([user('u1'), assistant('a1'), user('u2'), assistant('a2')]));
  for (const ids of [[], ['absent']]) {
    assert.deepEqual(deleteConversationMessages(source, ids), { conversation: source, deletedCount: 0, originalDataDropped: false });
    assert.equal(deleteConversationMessages(source, ids).conversation, source);
  }
  const start = deleteConversationMessages(source, ['u1', 'a1', 'u1', 'unknown']).conversation;
  assert.deepEqual(start.messages.map(item => item.id), ['u2', 'a2']);
  assert.equal(start.messages[0].contextBoundaryBefore, true);
  assert.deepEqual(contents(start), ['u2', 'a2', 'now']);
  const tail = deleteConversationMessages(source, ['u2', 'a2']);
  assert.equal(tail.deletedCount, 2);
  assert.equal(tail.conversation.messages[0], source.messages[0]);
  assert.equal(tail.conversation.messages[1], source.messages[1]);
  assert.deepEqual(contents(tail.conversation), ['u1', 'a1', 'now']);
  const all = deleteConversationMessages(source, source.messages.map(item => item.id));
  assert.equal(all.deletedCount, 4); assert.deepEqual(all.conversation.messages, []);
  assert.deepEqual(contents(all.conversation), ['now']);
});

test('deleting excluded assistant replies cannot revive their surviving questions as standalone messages', () => {
  const excluded: Partial<Message>[] = [
    { status: 'error', contextEligible: true }, { status: 'refused' }, { status: 'stopped' },
    { status: 'stopped', contextEligible: false }, { status: 'streaming', contextEligible: true },
    { status: 'complete', contextEligible: false }, { content: '   ' },
  ];
  for (const extra of excluded) {
    const source = conversation([user('u1'), assistant('bad', extra), user('u2'), assistant('a2')]);
    const deleted = deleteConversationMessages(source, ['bad']).conversation;
    assert.equal(deleted.messages[0].contextEligible, false);
    assert.deepEqual(contents(deleted), ['u2', 'a2', 'now']);
    assert.deepEqual(contents(roundTrip(deleted)), ['u2', 'a2', 'now']);
  }
  const alreadySeparated = conversation([user('unrelated'), assistant('bad', { status: 'error', contextBoundaryBefore: true })]);
  assert.deepEqual(contents(deleteConversationMessages(alreadySeparated, ['bad']).conversation), ['unrelated', 'now']);
  const allowed = conversation([user('valid'), assistant('partial', { status: 'stopped', contextEligible: true })]);
  assert.deepEqual(contents(deleteConversationMessages(allowed, ['partial']).conversation), ['valid', 'now']);
});

test('native backup preserves deletion boundaries and revision without suppressing an unrelated user before a failed reply', () => {
  const source = conversation([user('keep'), user('remove'), assistant('failed', { status: 'error' })]);
  const deleted = deleteConversationMessages(source, ['remove']).conversation;
  const backup = roundTrip(deleted);
  assert.equal(backup.redactionRevision, 1);
  assert.equal(backup.messages[1].contextBoundaryBefore, true);
  assert.equal(backup.messages[0].contextEligible, true);
  assert.deepEqual(contents(backup), ['keep', 'now']);
});

test('legacy source nodes are emptied using a structural whitelist, with synthetic IDs and untouched nodes preserved', () => {
  const raw = { id: 'legacy', title: '历史', messages: [
    { role: 'user', content: 'delete-body', reasoning: 'delete-thought', error: 'delete-error',
      files: [{ filename: 'delete-filename' }], future_payload: { secret: 'delete-future' } },
    { role: 'assistant', content: 'keep-answer' },
    { message_id: 'third', role: 'user', content: 'keep-question' },
  ] };
  const source = deepFreeze(parseHistory(JSON.stringify([raw]), 'legacy.json').conversations[0]);
  const deleted = deleteConversationMessages(source, ['message-0']).conversation;
  const original = deleted.originalData as typeof raw;
  assert.equal(original.messages.length, 3);
  assert.equal(original.messages[1], (source.originalData as typeof raw).messages[1]);
  assert.equal(original.messages[2], (source.originalData as typeof raw).messages[2]);
  assert.deepEqual(original.messages[0], { role: 'user', status: 'FINISHED', content: '', fragments: [], contextEligible: false });
  const backup = exportOne(deleted);
  for (const secret of ['delete-body', 'delete-thought', 'delete-error', 'delete-filename', 'delete-future']) assert.ok(!backup.includes(secret), secret);
  assert.deepEqual(contents(roundTrip(deleted)), ['keep-question', 'now']);
  const second = deleteConversationMessages(deleted, ['message-1']).conversation;
  assert.equal((second.originalData as typeof raw).messages[1].content, '');
  assert.equal((second.originalData as typeof raw).messages[2].message_id, 'third');
});

test('official numeric zero IDs, graph topology, and untouched inactive branches survive source redaction', () => {
  const date = '2026-11-17T00:00:00Z';
  const raw = { id: 'zero', title: '零号', inserted_at: date, updated_at: date, current_message_id: 1, messages: [
    { id: 0, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: date,
      fragments: [{ type: 'REQUEST', content: 'delete-official' }], unknown_payload: { text: 'delete-alias' } },
    { id: 1, parent_id: 0, role: 'ASSISTANT', status: 'FINISHED', inserted_at: date, fragments: [{ type: 'RESPONSE', content: 'active-answer' }] },
    { id: 2, parent_id: 0, role: 'ASSISTANT', status: 'FINISHED', inserted_at: date, fragments: [{ type: 'RESPONSE', content: 'other-branch' }] },
  ] };
  const archive = zipSync({ 'manifest.json': strToU8('{"export_format_version":3}'),
    'chat_sessions/zero.json': strToU8(JSON.stringify(raw)),
    'chat_session_index.json': strToU8('[{"id":"zero","message_count":3}]') });
  const source = deepFreeze(parseHistory(archive, 'official.zip').conversations[0]);
  const deleted = deleteConversationMessages(source, ['0']).conversation;
  const original = deleted.originalData as typeof raw;
  assert.equal(original.current_message_id, 1);
  assert.equal(original.messages[0].id, 0);
  assert.equal(original.messages[0].parent_id, null);
  assert.equal(original.messages[0].inserted_at, date);
  assert.deepEqual(original.messages[0].fragments, []);
  assert.equal(original.messages[1], (source.originalData as typeof raw).messages[1]);
  assert.equal(original.messages[2], (source.originalData as typeof raw).messages[2]);
  assert.ok(!exportOne(deleted).includes('delete-official'));
  assert.ok(!exportOne(deleted).includes('delete-alias'));
  assert.ok(exportOne(deleted).includes('other-branch'));
});

test('mapping source uses wrapper IDs, clears selected wrapper/message payload, and supports own __proto__ keys', () => {
  const raw = JSON.parse('{"id":"mapping","current_node":"reply","mapping":{"root":{"id":"root","parent":null,"children":["__proto__"],"message":null},"__proto__":{"id":"__proto__","parent":"root","children":["reply"],"future":"delete-wrapper","message":{"id":"nested-different","author":{"role":"user","name":"delete-author"},"content":{"parts":["delete-mapping"]},"future":{"text":"delete-message"}}},"reply":{"id":"reply","parent":"__proto__","children":[],"message":{"author":{"role":"assistant"},"content":{"parts":["keep-mapping-answer"]}}}}}');
  const source = deepFreeze(parseHistory(JSON.stringify([raw]), 'legacy.json').conversations[0]);
  const deleted = deleteConversationMessages(source, ['__proto__']).conversation;
  const mapping = (deleted.originalData as typeof raw).mapping;
  assert.equal(Object.hasOwn(mapping, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(mapping), Object.prototype);
  assert.equal(mapping.root, (source.originalData as typeof raw).mapping.root);
  assert.equal(mapping.reply, (source.originalData as typeof raw).mapping.reply);
  assert.deepEqual(mapping.__proto__, { id: '__proto__', parent: 'root', children: ['reply'],
    message: { id: 'nested-different', role: 'user', author: { role: 'user' }, status: 'FINISHED', content: '', fragments: [], contextEligible: false } });
  const backup = exportOne(deleted);
  for (const secret of ['delete-wrapper', 'delete-author', 'delete-mapping', 'delete-message']) assert.ok(!backup.includes(secret), secret);
  assert.deepEqual(contents(roundTrip(deleted)), ['now']);
});

test('unknown or ambiguous original copies are dropped with a warning while unselected visible messages survive', () => {
  const raws: unknown[] = [null, [], { future: 'delete-unknown' },
    { messages: [], mapping: {} }, { messages: [{ id: 'remove', role: 'user' }, { id: 'remove', role: 'user' }] },
    { messages: [{ id: 'remove', role: 'assistant' }] }, { mapping: { remove: { message: null } } },
    { messages: [{ id: 'remove', role: 'user', payload: { original_text: 'delete-unknown' } }],
      customExport: { allMessages: [{ id: 'remove', content: 'delete-unknown' }] } },
  ];
  for (const originalData of raws) {
    const source = conversation([user('remove'), assistant('keep')], { originalData });
    const result = deleteConversationMessages(source, ['remove']);
    assert.equal(result.originalDataDropped, true);
    assert.equal(Object.hasOwn(result.conversation, 'originalData'), false);
    assert.deepEqual(result.conversation.messages.map(item => item.id), ['keep']);
    assert.deepEqual(result.conversation.importWarnings, [ORIGINAL_DATA_REMOVED_WARNING]);
    assert.equal(source.originalData, originalData);
    assert.ok(!exportOne(result.conversation).includes('delete-unknown'));
  }
});

test('deleting a local message preserves known untouched source identity and never serializes opaque payloads', () => {
  const originalData = { id: 'legacy', messages: [{ id: 'old', role: 'user', content: 'old' }],
    opaque: { toJSON() { throw new Error('must not serialize source during deletion'); } } };
  const source = conversation([user('old'), user('local')], { originalData });
  const result = deleteConversationMessages(source, ['local']);
  assert.equal(result.conversation.originalData, originalData);
  assert.equal(result.originalDataDropped, false);
  const node = { id: 'remove', role: 'user', content: 'secret', get unknown() { throw new Error('must not read unknown source payload'); } };
  assert.doesNotThrow(() => deleteConversationMessages(conversation([user('remove')], { originalData: { messages: [node] } }), ['remove']));
});

test('native deletion metadata is strictly validated and raw imports cannot inject it', () => {
  const base = conversation([user('u'), assistant('a')]);
  for (const redactionRevision of [-1, 0.1, '1', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseHistory(JSON.stringify({ schemaVersion: 1, conversations: [{ ...base, redactionRevision }] }), 'app.json'), /删除版本/);
    assert.throws(() => exportOne({ ...base, redactionRevision } as Conversation), /删除版本/);
  }
  for (const contextBoundaryBefore of [0, 1, 'true', null, {}]) {
    const invalid = { ...base, messages: [{ ...base.messages[0], contextBoundaryBefore }, base.messages[1]] };
    assert.throws(() => parseHistory(JSON.stringify({ schemaVersion: 1, conversations: [invalid] }), 'app.json'), /消息边界/);
    assert.throws(() => exportOne(invalid as Conversation), /消息边界/);
  }
  for (const value of [() => 1, Symbol('invalid'), NaN, Infinity]) {
    assert.throws(() => exportOne({ ...base, redactionRevision: value } as unknown as Conversation), /删除版本/);
    assert.throws(() => exportOne({ ...base, messages: [{ ...base.messages[0], contextBoundaryBefore: value }] } as unknown as Conversation), /消息边界/);
  }
  const raw = { id: 'raw', redactionRevision: 'malicious', messages: [
    { id: 'u', role: 'user', content: 'u', contextBoundaryBefore: true },
    { id: 'a', role: 'assistant', content: 'a', contextBoundaryBefore: true },
  ] };
  const imported = parseHistory(JSON.stringify([raw]), 'legacy.json').conversations[0];
  assert.equal(imported.redactionRevision, undefined);
  assert.equal(imported.messages[0].contextBoundaryBefore, undefined);
  assert.equal(imported.messages[1].contextBoundaryBefore, undefined);
  assert.deepEqual(contents(imported), ['u', 'a', 'now']);
});

test('backup recovery cannot promote an ineligible stopped or interrupted assistant into context', () => {
  for (const extra of [{ status: 'stopped' }, { status: 'stopped', contextEligible: false },
    { status: 'streaming', contextEligible: true }] as Partial<Message>[]) {
    const recovered = roundTrip(conversation([user('question'), assistant('partial', extra)]));
    assert.equal(recovered.messages[1].contextEligible, false);
    assert.deepEqual(contents(recovered), ['now']);
  }
  assert.deepEqual(contents(roundTrip(conversation([user('q'), assistant('a', { status: 'stopped', contextEligible: true })]))), ['q', 'a', 'now']);
});

test('invalid deletion metadata and duplicate live IDs fail before altering data', () => {
  const base = deepFreeze(conversation([user('u'), assistant('a')]));
  assert.throws(() => deleteConversationMessages({ ...base, redactionRevision: Number.MAX_SAFE_INTEGER }, ['u']), /删除版本/);
  assert.throws(() => deleteConversationMessages({ ...base, redactionRevision: -1 }, ['u']), /删除版本/);
  assert.throws(() => deleteConversationMessages(base, ['u'], NaN), /删除版本或时间/);
  assert.throws(() => deleteConversationMessages({ ...base, messages: [base.messages[0], base.messages[0]] }, ['u']), /消息编号重复/);
  assert.throws(() => deleteConversationMessages({ ...base, messages: [{ ...base.messages[0], contextBoundaryBefore: 1 as never }] }, ['u']), /消息边界/);
  assert.deepEqual(base.messages.map(item => item.content), ['u', 'a']);
});
