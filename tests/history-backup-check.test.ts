import assert from 'node:assert/strict';
import test from 'node:test';
import { exportHistory } from '../src/core/history';
import { assertHistoryBackupable } from '../src/core/history-backup-check';
import { emptyState, type Conversation } from '../src/core/types';

function conversation(id: string): Conversation {
  return { id, title: `对话 ${id}`, createdAt: 1, updatedAt: 2,
    messages: [{ id: `${id}-u`, role: 'user', content: '中文、emoji 🍗、引号 " 和反斜杠 \\，\n换行', createdAt: 1, status: 'complete' },
      { id: `${id}-a`, role: 'assistant', content: '可以接着聊。', createdAt: 2, status: 'complete' }],
    originalData: { unicode: 'é日本語😀', scalar: [null, true, false, 0, -1, 3.25, 1e30],
      escaped: '\t\r\n\b\f\\\"', empty: { list: [], object: {} }, surrogate: '\ud800' } };
}
function countNodes(value: unknown): number {
  if (value === null || typeof value !== 'object') return 1;
  const children: unknown[] = Array.isArray(value) ? value : Object.values(value);
  return children.reduce<number>((total, child) => total + countNodes(child), 1);
}

test('incremental backup check exactly measures the real exported bytes/nodes without serializing the full library', async () => {
  const state = { ...emptyState(), conversations: [conversation('one'), conversation('two'), conversation('three')], activeConversationId: 'two' };
  const full = exportHistory(state);
  const expectedNodes = countNodes(JSON.parse(full));
  const before = JSON.stringify(state);
  const references = [...state.conversations];
  const sizes: number[] = []; const progress: number[] = []; let yields = 0;
  const originalStringify = JSON.stringify;
  JSON.stringify = ((value: unknown) => {
    if (value && typeof value === 'object' && 'conversations' in value && Array.isArray(value.conversations)) sizes.push(value.conversations.length);
    return originalStringify(value);
  }) as typeof JSON.stringify;
  try {
    const result = await assertHistoryBackupable(state, { yieldControl: async () => { yields++; },
      onProgress: value => { assert.equal(value.total, 3); progress.push(value.completed); } });
    assert.equal(result.bytes, Buffer.byteLength(full, 'utf8'));
    assert.equal(result.jsonNodes, expectedNodes);
    assert.equal(result.messageCount, 6);
    assert.equal(result.conversationCount, 3);
    assert.ok(sizes.length >= 3);
    assert.ok(sizes.every(size => size <= 1), 'never serialize an envelope containing multiple conversations');
    assert.equal(yields, 3);
    assert.deepEqual(progress, [0, 1, 2, 3]);
  } finally { JSON.stringify = originalStringify; }
  assert.equal(JSON.stringify(state), before);
  references.forEach((reference, index) => assert.equal(state.conversations[index], reference));
});

test('empty backup check still accounts for the full envelope', async () => {
  const state = emptyState();
  const result = await assertHistoryBackupable(state);
  const text = exportHistory(state);
  assert.equal(result.bytes, Buffer.byteLength(text));
  assert.equal(result.jsonNodes, countNodes(JSON.parse(text)));
  assert.equal(result.messageCount, 0);
  assert.equal(result.conversationCount, 0);
});

test('incremental backup check preserves cross-conversation duplicate ID and source rules', async () => {
  for (const conversations of [
    [conversation('one'), conversation('one')],
    [{ ...conversation('one'), sourceId: 'same-source' }, { ...conversation('two'), sourceId: 'same-source' }],
    [conversation('one'), { ...conversation('two'), sourceId: 'local:one' }],
  ]) {
    const state = { ...emptyState(), conversations };
    assert.throws(() => exportHistory(state), /重复/);
    await assert.rejects(assertHistoryBackupable(state), /重复/);
  }
});

test('failed per-conversation validation leaves every existing record unchanged', async () => {
  const old = conversation('existing');
  const invalid = conversation('bad');
  invalid.messages[0].contextBoundaryBefore = 'not-a-boolean' as never;
  const state = { ...emptyState(), conversations: [old, invalid] };
  const before = JSON.stringify(state); const completed: number[] = [];
  await assert.rejects(assertHistoryBackupable(state, { onProgress: item => completed.push(item.completed) }), /边界/);
  assert.deepEqual(completed, [0, 1]);
  assert.equal(state.conversations[0], old);
  assert.equal(JSON.stringify(state), before);
});

test('incremental validation keeps rejection of malformed optional fields and deep original imports', async () => {
  const malformedRevision = { ...conversation('revision'), redactionRevision: (() => 1) as never };
  const malformedUsage = conversation('usage');
  malformedUsage.messages[1].contextUsage = { includedHistoryMessages: 2, eligibleHistoryMessages: 1, omittedHistoryMessages: 0, truncated: false };
  const tooDeep = conversation('depth');
  let nested: unknown = null;
  for (let index = 0; index < 70; index++) nested = { next: nested };
  tooDeep.originalData = nested;
  for (const item of [malformedRevision, malformedUsage, tooDeep]) {
    const state = { ...emptyState(), conversations: [conversation('valid'), item] };
    assert.throws(() => exportHistory(state));
    await assert.rejects(assertHistoryBackupable(state));
  }
});
