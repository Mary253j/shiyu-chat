import type { ChatDelta } from './deepseek';

type Schedule = (callback: () => void, delay: number) => () => void;
const scheduleTimeout: Schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
};

/** Batch token bursts without delaying a refusal or losing the final partial reply. */
export function createStreamBuffer(
  onBatch: (delta: ChatDelta) => void,
  intervalMs = 80,
  schedule: Schedule = scheduleTimeout,
) {
  let content: string[] = [];
  let reasoning: string[] = [];
  let cancelTimer: (() => void) | null = null;
  let closed = false;
  let refused = false;

  function discard() {
    cancelTimer?.();
    cancelTimer = null;
    content = [];
    reasoning = [];
  }
  function flush() {
    cancelTimer?.();
    cancelTimer = null;
    if (closed || refused || (!content.length && !reasoning.length)) return;
    const batch = { content: content.join(''), reasoning: reasoning.join('') };
    content = [];
    reasoning = [];
    onBatch(batch);
  }
  function push(delta: ChatDelta) {
    if (closed || refused) return;
    if (delta.refused) {
      refused = true;
      discard();
      onBatch({ refused: true });
      return;
    }
    if (delta.content) content.push(delta.content);
    if (delta.reasoning) reasoning.push(delta.reasoning);
    if (!cancelTimer && (content.length || reasoning.length)) cancelTimer = schedule(flush, intervalMs);
  }
  return {
    push,
    flush,
    dispose() { closed = true; discard(); },
  };
}
