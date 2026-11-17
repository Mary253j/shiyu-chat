import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContextPlan, ContextPlanError, estimateTextTokens, MODEL_CONTEXT_TOKENS,
  CONTEXT_SAFETY_RESERVE, MISSING_ATTACHMENT_PLACEHOLDER, MISSING_ATTACHMENT_REFERENCE,
  type RequestMessage,
} from '../src/core/context';
import { streamChat } from '../src/core/deepseek';
import { defaultSettings, type Message, type MessageAttachment } from '../src/core/types';

const msg = (id: string, role: Message['role'], content = id, extra: Partial<Message> = {}): Message => ({
  id, role, content, createdAt: 1, status: 'complete', ...extra,
});
const user = (id: string, content = id, extra: Partial<Message> = {}) => msg(id, 'user', content, extra);
const assistant = (id: string, content = id, extra: Partial<Message> = {}) => msg(id, 'assistant', content, extra);
const pairs = (count: number) => Array.from({ length: count }, (_, index) => [user(`u${index}`), assistant(`a${index}`)]).flat();
const file = (id: string, extra: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id, name: `${id}.txt`, mimeType: 'text/plain', bytes: 100, kind: 'document',
  remote: { fileId: `file-api-${id}`, purpose: 'user_data', createdAt: 1 }, ...extra,
});
const files = (prefix: string, count = 4) => Array.from({ length: count }, (_, index) => file(`${prefix}-${index}`));
function fileReferences(messages: RequestMessage[]) {
  return messages.reduce((sum, message) => sum + (Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'file').length : 0), 0);
}
const textContents = (messages: RequestMessage[]) => messages.map(message => message.content);
const successResponse = () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
  headers: { 'Content-Type': 'text/event-stream' },
});

test('auto, including old settings with no mode, retains more than the old 40 or 201 message cap', () => {
  const messages = [...pairs(150), user('now')];
  for (const contextMode of [undefined, 'auto'] as const) {
    const plan = buildContextPlan(messages, { ...defaultSettings, contextMode, contextMessageLimit: 40 });
    assert.equal(plan.messages.length, 301);
    assert.deepEqual(plan.usage, { includedHistoryMessages: 300, eligibleHistoryMessages: 300, omittedHistoryMessages: 0, truncated: false });
  }
});

test('recent mode cuts oldest whole units and reports the actual history count', () => {
  const messages = [user('standalone'), ...pairs(50), user('now')];
  for (const limit of [20, 40, 80]) {
    const plan = buildContextPlan(messages, { ...defaultSettings, contextMode: 'recent', contextMessageLimit: limit });
    assert.ok(plan.messages.length <= limit);
    assert.equal(plan.messages.at(-1)?.content, 'now');
    assert.equal(plan.messages[0].role, 'user');
    assert.equal(plan.usage.includedHistoryMessages, plan.messages.length - 1);
    assert.equal(plan.usage.eligibleHistoryMessages, 101);
    assert.equal(plan.usage.omittedHistoryMessages, 101 - (plan.messages.length - 1));
    assert.equal(plan.usage.truncated, true);
    assert.match(plan.usage.reason ?? '', /最近消息/);
  }
});

test('unanswered users are retained without reviving questions associated with failed replies', () => {
  const plan = buildContextPlan([
    user('u1'), user('u2'), assistant('error', 'failed', { status: 'error', contextEligible: true }),
    user('u3'), assistant('a3'), user('unanswered'), user('now'),
  ], defaultSettings);
  assert.deepEqual(textContents(plan.messages), ['u1', 'u3', 'a3', 'unanswered', 'now']);
  assert.equal(plan.usage.eligibleHistoryMessages, 4);
});

test('stopped replies require explicit eligibility; failure and refusal never become eligible via true', () => {
  const messages: Message[] = [];
  const cases: Partial<Message>[] = [
    { status: 'stopped', contextEligible: true }, { status: 'stopped', contextEligible: false },
    { status: 'stopped' }, { status: 'streaming', contextEligible: true },
    { status: 'error', contextEligible: true }, { status: 'refused', contextEligible: true },
    { status: 'complete', contextEligible: false },
  ];
  cases.forEach((extra, index) => messages.push(user(`u${index}`), assistant(`a${index}`, `a${index}`, extra)));
  assert.deepEqual(textContents(buildContextPlan([...messages, user('now')], defaultSettings).messages), ['u0', 'a0', 'now']);
});

test('missing original attachment uses an exact provenance notice and only a complete eligible summary', () => {
  const missing = user('missing', MISSING_ATTACHMENT_PLACEHOLDER, { contextEligible: false });
  const summary = assistant('summary', '已存在的文字总结');
  const plan = buildContextPlan([missing, summary, user('now')], defaultSettings);
  assert.deepEqual(textContents(plan.messages), [MISSING_ATTACHMENT_REFERENCE, '已存在的文字总结', 'now']);
  assert.equal(fileReferences(plan.messages), 0);
  assert.match(plan.usage.reason ?? '', /原附件未恢复/);
  for (const extra of [{ status: 'refused' }, { status: 'error' }, { status: 'stopped', contextEligible: true }, { contextEligible: false }] as Partial<Message>[]) {
    assert.deepEqual(textContents(buildContextPlan([missing, { ...summary, ...extra }, user('now')], defaultSettings).messages), ['now']);
  }
  assert.deepEqual(textContents(buildContextPlan([{ ...missing, content: '任意被排除的消息' }, summary, user('now')], defaultSettings).messages), ['now']);
});

test('text budgeting uses UTF-8 bytes, including surrogate pairs, rather than character counts', () => {
  for (const value of ['ASCII', '中文', '🍊', 'a中🍊', '\ud800', '\udc00', '\ud800x']) {
    assert.equal(estimateTextTokens(value), new TextEncoder().encode(value).length);
  }
});

test('output reserve changes the boundary and oversized oldest units are removed without truncating text', () => {
  const length = MODEL_CONTEXT_TOKENS - CONTEXT_SAFETY_RESERVE - 512 - 64 - 64 - 1;
  const old = user('old', 'x'.repeat(length)); const now = user('now', 'q');
  const smallOutput = buildContextPlan([old, now], { ...defaultSettings, maxOutputTokens: 512 });
  assert.equal(smallOutput.messages.length, 2);
  assert.equal(smallOutput.messages[0].content, old.content);
  const largeOutput = buildContextPlan([old, now], { ...defaultSettings, maxOutputTokens: 4096 });
  assert.deepEqual(textContents(largeOutput.messages), ['q']);
  assert.equal(largeOutput.usage.omittedHistoryMessages, 1);
  assert.match(largeOutput.usage.reason ?? '', /历史文字较长/);
});

test('an oversized current question fails before transport and is never silently shortened', async () => {
  let calls = 0;
  await assert.rejects(streamChat({
    apiKey: 'sk-synthetic', messages: [user('now', '中'.repeat(400000))], settings: defaultSettings,
    onDelta: () => undefined, fetchImpl: async () => { calls++; return successResponse(); },
  }), error => error instanceof ContextPlanError && error.code === 'current_message_too_large');
  assert.equal(calls, 0);
});

test('21+ file references trim oldest complete turns, including repeated references', () => {
  const history = Array.from({ length: 6 }, (_, index) => [
    user(`u${index}`, `问题${index}`, { attachments: files(`group${index}`) }), assistant(`a${index}`),
  ]).flat();
  const now = user('now', '新问题', { attachments: files('current', 1) });
  const plan = buildContextPlan([...history, now], defaultSettings);
  assert.equal(fileReferences(plan.messages), 17); // 25 -> remove two complete 4-file turns.
  assert.equal(plan.messages.length, 9);
  assert.equal(plan.usage.eligibleHistoryMessages, 12);
  assert.equal(plan.usage.includedHistoryMessages, 8);
  assert.equal(plan.usage.omittedHistoryMessages, 4);
  assert.match(plan.usage.reason ?? '', /20 个文件/);
  assert.equal(plan.messages[1].content, 'a2');
  const repeated = Array.from({ length: 21 }, (_, index) => [
    user(`u${index}`, '', { attachments: [file('same')] }), assistant(`a${index}`),
  ]).flat();
  const repeatedPlan = buildContextPlan([...repeated, user('now')], defaultSettings);
  assert.equal(fileReferences(repeatedPlan.messages), 20);
  assert.equal(repeatedPlan.usage.omittedHistoryMessages, 2);
});

test('Flash actual request uses whitelisted text/file parts, with no metadata or local file bytes', async () => {
  const attachment = { ...file('document'), localUri: '/private/file', base64: 'never-send', extra: 'never-send' };
  const messages = [user('now', '阅读附件', { attachments: [attachment] })];
  const plan = buildContextPlan(messages, defaultSettings);
  let request: { messages: RequestMessage[] } | undefined;
  await streamChat({ apiKey: 'sk-synthetic', messages, settings: defaultSettings, onDelta: () => undefined,
    fetchImpl: async (_url, init) => { request = JSON.parse(String(init?.body)); return successResponse(); } });
  assert.deepEqual(request?.messages, plan.messages);
  assert.deepEqual(request?.messages, [{ role: 'user', content: [
    { type: 'text', text: '阅读附件' }, { type: 'file', file_id: 'file-api-document' },
  ] }]);
  assert.ok(!JSON.stringify(request).includes('never-send'));
  assert.match(plan.usage.reason ?? '', /无法在本机准确估算/);
});

test('file bytes are never used as parsed token counts and attachment-only current messages work', () => {
  const large = file('large', { bytes: 20 * 1024 * 1024 });
  const plan = buildContextPlan([user('now', '', { attachments: [large] })], defaultSettings);
  assert.equal(fileReferences(plan.messages), 1);
  assert.equal(plan.usage.truncated, false);
  assert.match(plan.usage.reason ?? '', /服务方解析/);
});

test('Pro with selected attachments fails explicitly before transport', async () => {
  let calls = 0;
  await assert.rejects(streamChat({
    apiKey: 'sk-synthetic', messages: [user('now', '附件', { attachments: [file('one')] })],
    settings: { ...defaultSettings, model: 'deepseek-v4-pro' }, onDelta: () => undefined,
    fetchImpl: async () => { calls++; return successResponse(); },
  }), error => error instanceof ContextPlanError && error.code === 'attachment_unsupported_model');
  assert.equal(calls, 0);
});

test('invalid and expired file references fail explicitly instead of silently losing files', () => {
  for (const attachment of [file('wrong', { remote: { fileId: 'https://outside.invalid', purpose: 'user_data', createdAt: 1 } }),
    file('expired', { remote: { fileId: 'file-api-expired', purpose: 'user_data', createdAt: 1, expiresAt: 2 } })]) {
    assert.throws(() => buildContextPlan([user('now', '', { attachments: [attachment] })], defaultSettings), ContextPlanError);
  }
});

test('damaged old attachment metadata outside the selected range cannot block a text-only request', () => {
  const invalid = file('invalid', { remote: { fileId: 'invalid', purpose: 'user_data', createdAt: 1 } });
  const messages = [user('old', '', { attachments: [invalid] }), assistant('reply'), user('now')];
  assert.throws(() => buildContextPlan(messages, defaultSettings), ContextPlanError);
  for (const contextMessageLimit of [1, 2]) {
    const plan = buildContextPlan(messages, { ...defaultSettings, contextMode: 'recent', contextMessageLimit });
    assert.deepEqual(textContents(plan.messages), ['now']);
    assert.equal(plan.usage.omittedHistoryMessages, 2);
  }
});

test('unknown roles, reasoning, and original metadata cannot inject instructions or bridge context', () => {
  const messages = [user('u'), { role: 'system', content: 'do not send', status: 'complete' }, assistant('a'),
    { ...user('now'), reasoning: 'do not send', originalData: { instruction: 'do not send' } }] as Message[];
  assert.deepEqual(buildContextPlan(messages, defaultSettings).messages, [{ role: 'user', content: 'now' }]);
});

test('API 400 errors suggest reducing attachment/context scope without exposing response data', async () => {
  await assert.rejects(streamChat({ apiKey: 'sk-synthetic', messages: [user('now')], settings: defaultSettings,
    onDelta: () => undefined, fetchImpl: async () => new Response('private backend details', { status: 400 }) }),
  error => error instanceof Error && /减少附件、缩小上下文/.test(error.message) && !error.message.includes('private'));
});
