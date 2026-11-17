import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamBuffer } from '../src/core/streamBuffer';
import type { ChatDelta } from '../src/core/deepseek';

function harness() {
  const batches: ChatDelta[] = [];
  const timers: { run: () => void; cancelled: boolean; delay: number }[] = [];
  const buffer = createStreamBuffer(batch => batches.push(batch), 80, (run, delay) => {
    const timer = { run, cancelled: false, delay };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  return { buffer, batches, timers, tick() {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
  } };
}

test('token bursts update the UI once per batch and preserve text order', () => {
  const h = harness();
  for (const part of ['你', '好', '🙂']) h.buffer.push({ content: part });
  h.buffer.push({ reasoning: '先想一想。' });
  assert.equal(h.batches.length, 0);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 80);
  h.tick();
  assert.deepEqual(h.batches, [{ content: '你好🙂', reasoning: '先想一想。' }]);
  h.buffer.push({ content: '接着聊。' }); h.tick();
  assert.equal(h.batches[1].content, '接着聊。');
});

test('completion or interruption can flush the last partial output exactly once', () => {
  const h = harness();
  h.buffer.push({ content: '最后一句', reasoning: '思考' });
  h.buffer.flush(); h.buffer.flush(); h.tick();
  assert.deepEqual(h.batches, [{ content: '最后一句', reasoning: '思考' }]);
});

test('refusal immediately discards pending output and suppresses later content', () => {
  const h = harness();
  h.buffer.push({ content: '已显示' }); h.tick();
  h.buffer.push({ content: '待显示', reasoning: '待显示的思考' });
  h.buffer.push({ refused: true, content: '也应丢弃' });
  h.buffer.push({ content: '拒绝之后' });
  h.buffer.flush(); h.tick();
  assert.deepEqual(h.batches, [{ content: '已显示', reasoning: '' }, { refused: true }]);
});

test('disposed requests cannot deliver late timers into a different conversation', () => {
  const h = harness();
  h.buffer.push({ content: '旧请求' });
  const lateCallback = h.timers[0].run;
  h.buffer.dispose(); lateCallback();
  h.buffer.push({ content: '更多旧内容' }); h.buffer.flush();
  assert.deepEqual(h.batches, []);
});

test('empty deltas do not schedule renders and a thousand tokens stay in one batch', () => {
  const h = harness();
  h.buffer.push({}); h.buffer.push({ content: '', reasoning: '' });
  assert.equal(h.timers.length, 0);
  for (let i = 0; i < 1000; i++) h.buffer.push({ content: '字' });
  assert.equal(h.timers.length, 1);
  h.buffer.flush();
  assert.equal(h.batches.length, 1);
  assert.equal(h.batches[0].content, '字'.repeat(1000));
});
