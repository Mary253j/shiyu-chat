import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { parseHistory } from '../src/core/history';
import { streamChat, type RequestMessage } from '../src/core/deepseek';
import { defaultSettings, type Conversation, type Message, type Settings } from '../src/core/types';

// Synthetic fixtures only. These tests intercept the real streamChat request
// body after the official ZIP importer and the same append step as AppProvider.
const date = '2026-11-17T00:00:00.000Z';
const fragment = (type: string, content: string) => ({ type, content });
function archivedMessage(id: number, parent: number | null, role: 'USER' | 'ASSISTANT', content: string, status = 'FINISHED') {
  return {
    id, parent_id: parent, role, status, inserted_at: date,
    thinking_enabled: false, search_enabled: false, accumulated_token_usage: 0,
    fragments: [fragment(role === 'USER' ? 'REQUEST' : 'RESPONSE', content)],
  };
}
type ArchivedMessage = ReturnType<typeof archivedMessage>;
function importArchive(messages: ArchivedMessage[], current = messages.at(-1)?.id ?? 0): Conversation {
  const session = { id: 'synthetic-diary', title: '合成日记', inserted_at: date, updated_at: date, current_message_id: current, messages };
  const bytes = zipSync({
    'manifest.json': strToU8('{"export_format_version":3}'),
    'chat_sessions/synthetic-diary.json': strToU8(JSON.stringify(session)),
    'chat_session_index.json': strToU8(JSON.stringify([{ id: session.id, message_count: messages.length }])),
  });
  return parseHistory(bytes, 'deepseek_data-synthetic.zip').conversations[0];
}
function diaryPairs(count: number) {
  return Array.from({ length: count }, (_, index) => [
    archivedMessage(index * 2 + 1, index ? index * 2 : null, 'USER', `第${index + 1}天：日记标记-${index + 1}`),
    archivedMessage(index * 2 + 2, index * 2 + 1, 'ASSISTANT', `第${index + 1}天的回应`),
  ]).flat();
}
async function actualRequest(conversation: Conversation, limit = defaultSettings.contextMessageLimit, mode: Settings['contextMode'] = undefined) {
  let body: { messages: RequestMessage[]; [key: string]: unknown } | undefined;
  const current: Message = { id: 'new-question', role: 'user', status: 'complete', content: '请总结我之前几个月的日记', createdAt: 1 };
  // AppProvider passes conversation.messages + the new user message, excluding
  // the streaming assistant placeholder which it renders in the local state.
  await streamChat({
    apiKey: 'sk-synthetic-never-sent', messages: [...conversation.messages, current],
    settings: { ...defaultSettings, contextMessageLimit: limit, contextMode: mode }, onDelta: () => undefined,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"合成响应"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  assert.ok(body);
  return body;
}

test('import context control: finished official text reaches the actual API body in order', async () => {
  const conversation = importArchive(diaryPairs(3));
  assert.ok(conversation.messages.every(message => message.contextEligible));
  const body = await actualRequest(conversation);
  assert.deepEqual(body.messages.slice(0, -1).map(message => message.content), conversation.messages.map(message => message.content));
  assert.equal(body.messages.length, 7);
  assert.equal(body.messages.at(-1)?.content, '请总结我之前几个月的日记');
  assert.ok(body.messages.every(message => Object.keys(message).sort().join(',') === 'content,role'));
});

test('import context: auto carries all 180 diary messages while explicit recent mode preserves its limit', async () => {
  const conversation = importArchive(diaryPairs(90));
  assert.equal(conversation.messages.length, 180);
  const body = await actualRequest(conversation);
  assert.equal(defaultSettings.contextMessageLimit, 40);
  assert.equal(body.messages.length, 181);
  assert.equal(body.messages[0].content, '第1天：日记标记-1');
  const recent = await actualRequest(conversation, 40, 'recent');
  assert.equal(recent.messages.length, 39);
  assert.equal(recent.messages[0].content, '第72天：日记标记-72');
  assert.equal((await actualRequest(conversation, 80, 'recent')).messages.length, 79);
});

test('import context: explicitly eligible imported INCOMPLETE and WIP replies remain in the actual request', async () => {
  for (const status of ['INCOMPLETE', 'WIP']) {
    const messages = diaryPairs(1); messages[1].status = status;
    const conversation = importArchive(messages);
    assert.equal(conversation.messages[1].status, 'stopped');
    assert.equal(conversation.messages[1].contextEligible, true);
    assert.equal(conversation.messages[0].contextEligible, true);
    assert.equal((await actualRequest(conversation)).messages.length, 3, status);
  }
});

test('import context safety: failures and refusals must stay excluded even when context capacity increases', async () => {
  for (const status of ['FAILED', 'TIMEOUT', 'CONTENT_FILTER', 'CONTEXT_LENGTH_EXCEEDED']) {
    const messages = diaryPairs(1); messages[1].status = status;
    const conversation = importArchive(messages);
    assert.equal(conversation.messages[0].contextEligible, false);
    assert.equal(conversation.messages[1].contextEligible, false);
    assert.equal((await actualRequest(conversation, 201)).messages.length, 1, status);
  }
});

test('import context safety: only the selected branch is transmitted; originalData is retained but never injected', async () => {
  const messages = [
    archivedMessage(1, null, 'USER', '共同的第一条日记'),
    archivedMessage(2, 1, 'ASSISTANT', '当前选中的回答'),
    archivedMessage(3, 1, 'ASSISTANT', '另一个分支的回答'),
    archivedMessage(4, 3, 'USER', '只在其他分支的私密信息'),
    archivedMessage(5, 4, 'ASSISTANT', '其他分支的新总结'),
  ];
  const conversation = importArchive(messages, 2);
  assert.equal((conversation.originalData as { messages: unknown[] }).messages.length, 5);
  assert.equal(conversation.messages.length, 2);
  const body = await actualRequest(conversation, 201);
  assert.deepEqual(body.messages.slice(0, -1).map(message => message.content), ['共同的第一条日记', '当前选中的回答']);
  assert.ok(!JSON.stringify(body).includes('只在其他分支'));
});

test('import context: an unanswered final user diary is preserved on the next question', async () => {
  const messages = diaryPairs(1);
  messages.push(archivedMessage(3, 2, 'USER', '尚未得到回答的关键日记'));
  const conversation = importArchive(messages);
  assert.equal(conversation.messages.at(-1)?.content, '尚未得到回答的关键日记');
  const body = await actualRequest(conversation);
  assert.equal(body.messages.length, 4);
  assert.ok(JSON.stringify(body).includes('尚未得到回答的关键日记'));
});

test('import context: a complete attachment summary is retained with an explicit missing-original notice', async () => {
  const messages = diaryPairs(1);
  messages[0].fragments = [{ type: 'FILE', files: [{ file_name: '日记.pdf', file_size: 10, export_path: null }] } as never];
  messages[1].fragments = [fragment('RESPONSE', '基于上传日记写出的可见完整总结')];
  const conversation = importArchive(messages);
  assert.equal(conversation.messages[0].contextEligible, false);
  assert.equal(conversation.messages[1].contextEligible, true);
  const body = await actualRequest(conversation);
  assert.equal(body.messages.length, 3);
  assert.match(String(body.messages[0].content), /原件未恢复/);
  assert.equal(body.messages[1].content, '基于上传日记写出的可见完整总结');
});

test('import context: long diaries are trimmed as complete units to the conservative input budget', async () => {
  const messages = diaryPairs(2);
  for (const message of messages) message.fragments[0].content += '很长的日记内容'.repeat(20000);
  const conversation = importArchive(messages);
  const expected = conversation.messages.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(expected > 200000);
  const body = await actualRequest(conversation);
  assert.ok(body.messages.slice(0, -1).reduce((sum, message) => sum + message.content.length, 0) < expected);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages.slice(0, -1).map(message => message.content), conversation.messages.slice(2).map(message => message.content));
});
