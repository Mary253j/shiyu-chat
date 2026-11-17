import type { Message, Settings } from './types';

const API_ORIGIN = 'https://api.deepseek.com';
const MAX_EVENT_CHARS = 1_048_576;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface ChatDelta {
  content?: string;
  reasoning?: string;
  /** The consumer must clear previously displayed content and reasoning. */
  refused?: boolean;
}
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
}
export interface ChatResult {
  usage?: TokenUsage;
  finishReason: string;
}
export interface StreamChatOptions {
  apiKey: string;
  /** Ends with the current user message; do not include the UI's reply placeholder. */
  messages: Message[];
  settings: Settings;
  signal?: AbortSignal;
  onDelta: (delta: ChatDelta) => void;
  fetchImpl?: FetchLike;
}
export interface Balance {
  available: boolean;
  /** Decimal string, preserving the service's monetary precision. */
  total: string;
  currency: string;
}

export type DeepSeekErrorCode =
  | 'missing_key' | 'invalid_request' | 'auth' | 'balance' | 'forbidden'
  | 'rate_limit' | 'server' | 'network' | 'interrupted' | 'protocol'
  | 'aborted' | 'redirect';

const errorMessages: Record<DeepSeekErrorCode, string> = {
  missing_key: '请先在设置中填写有效的 DeepSeek API Key。',
  invalid_request: '无法发送这条消息，请检查内容、模型和上下文设置。',
  auth: 'API Key 无效或已失效，请在设置中重新填写。',
  balance: 'DeepSeek API 账户余额不足，请检查官方平台账户。',
  forbidden: '此 API 账户暂时无法访问该服务，请检查账户权限。',
  rate_limit: '请求过于频繁，请稍后再试。',
  server: 'DeepSeek 服务暂时繁忙，请稍后再试。',
  network: '无法连接 DeepSeek，请检查网络后重试。',
  interrupted: '连接中断，回复未完成。请检查网络后重试。',
  protocol: '收到的回复格式异常，请稍后重试。',
  aborted: '已停止生成。',
  redirect: '已阻止异常跳转，请稍后重试。',
};

/** Never stores the key, raw response body, URL query, or original exception. */
export class DeepSeekError extends Error {
  constructor(readonly code: DeepSeekErrorCode, readonly status?: number) {
    super(errorMessages[code]);
    this.name = code === 'aborted' ? 'AbortError' : 'DeepSeekError';
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DeepSeekError('aborted');
}

function safeError(error: unknown, signal: AbortSignal | undefined, streaming = false): DeepSeekError {
  if (signal?.aborted || (record(error) && error.name === 'AbortError')) {
    return new DeepSeekError('aborted');
  }
  if (error instanceof DeepSeekError) return error;
  return new DeepSeekError(streaming ? 'interrupted' : 'network');
}

function httpError(status: number): DeepSeekError {
  if (status >= 300 && status < 400) return new DeepSeekError('redirect', status);
  const code = status === 401 ? 'auth'
    : status === 402 ? 'balance'
      : status === 403 ? 'forbidden'
        : status === 429 ? 'rate_limit'
          : status >= 500 ? 'server' : 'invalid_request';
  return new DeepSeekError(code, status);
}

function streamError(value: unknown): DeepSeekError {
  const error = record(value) && record(value.error) ? value.error : {};
  const code = error.code ?? error.type;
  if (code === 'invalid_api_key' || code === 'authentication_error') return new DeepSeekError('auth');
  if (code === 'insufficient_balance' || code === 'insufficient_quota') return new DeepSeekError('balance');
  if (code === 'rate_limit_exceeded' || code === 'rate_limit_error') return new DeepSeekError('rate_limit');
  return new DeepSeekError('server');
}

function cleanKey(apiKey: string): string {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key || key.length > 1024 || /[\s\x00-\x1f\x7f]/.test(key)) {
    throw new DeepSeekError('missing_key');
  }
  return key;
}

async function request(
  path: '/chat/completions' | '/user/balance',
  apiKey: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  assertNotAborted(signal);
  const key = cleanKey(apiKey);
  try {
    const response = await fetchImpl(`${API_ORIGIN}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: path === '/chat/completions' ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${key}`,
      },
      // The transport must honor this; credentials must never follow a redirect.
      redirect: 'error',
      credentials: 'omit',
    });
    assertNotAborted(signal);
    if (response.redirected) throw new DeepSeekError('redirect');
    if (response.url) {
      let origin: string;
      try { origin = new URL(response.url).origin; }
      catch { throw new DeepSeekError('protocol'); }
      if (origin !== API_ORIGIN) throw new DeepSeekError('redirect');
    }
    if (!response.ok) throw httpError(response.status);
    return response;
  } catch (error) {
    throw safeError(error, signal);
  }
}

export interface RequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

const eligible = (message: Message | undefined): message is Message =>
  !!message && message.status === 'complete' && message.contextEligible !== false
  && typeof message.content === 'string' && message.content.trim().length > 0;

/**
 * Keeps whole successful user/assistant pairs plus the current user message.
 * Failed, stopped, refused, and orphaned turns cannot become another turn's context.
 * Imported metadata and reasoning never enter the request, even if present at runtime.
 */
export function buildMessages(messages: Message[], contextMessageLimit: number): RequestMessage[] {
  const current = messages[messages.length - 1];
  if (!eligible(current) || current.role !== 'user') return [];

  const pairs: [RequestMessage, RequestMessage][] = [];
  let pendingUser: Message | undefined;
  for (const message of messages.slice(0, -1)) {
    if (message.role === 'user') {
      pendingUser = eligible(message) ? message : undefined;
    } else if (message.role === 'assistant') {
      if (pendingUser && eligible(message)) {
        pairs.push([
          { role: 'user', content: pendingUser.content },
          { role: 'assistant', content: message.content },
        ]);
      }
      pendingUser = undefined;
    } else {
      // A runtime object from an import may not conform to the TypeScript type.
      pendingUser = undefined;
    }
  }
  const limit = Number.isFinite(contextMessageLimit)
    ? Math.max(1, Math.min(201, Math.floor(contextMessageLimit))) : 41;
  const pairCount = Math.floor((limit - 1) / 2);
  const history = pairCount > 0 ? pairs.slice(-pairCount).flat() : [];
  return [...history, { role: 'user', content: current.content }];
}

/** Incremental SSE decoder; CRLF and UTF-8 may both straddle transport chunks. */
class SSEParser {
  private buffer = '';
  private lines: string[] = [];
  private event = '';
  private eventSize = 0;

  constructor(private readonly emit: (data: string, event: string) => void) {}

  push(text: string, final = false): void {
    this.buffer += text;
    let consumed = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && i === this.buffer.length - 1 && !final) break;
      this.line(this.buffer.slice(consumed, i));
      if (char === '\r' && this.buffer[i + 1] === '\n') i++;
      consumed = i + 1;
    }
    this.buffer = this.buffer.slice(consumed);
    if (this.buffer.length + this.eventSize > MAX_EVENT_CHARS) throw new DeepSeekError('protocol');
    if (final) {
      if (this.buffer.length) this.line(this.buffer);
      this.buffer = '';
      this.line('');
    }
  }

  private line(line: string): void {
    if (line === '') {
      if (this.lines.length) this.emit(this.lines.join('\n'), this.event);
      this.lines = [];
      this.event = '';
      this.eventSize = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    if (field === 'data') {
      this.eventSize += value.length;
      if (this.eventSize > MAX_EVENT_CHARS) throw new DeepSeekError('protocol');
      this.lines.push(value);
    }
  }
}

const tokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readUsage(value: unknown): TokenUsage | undefined {
  if (!record(value) || !tokenCount(value.prompt_tokens) || !tokenCount(value.completion_tokens)) {
    return undefined;
  }
  return {
    inputTokens: value.prompt_tokens,
    outputTokens: value.completion_tokens,
    totalTokens: tokenCount(value.total_tokens)
      ? value.total_tokens : value.prompt_tokens + value.completion_tokens,
    ...(tokenCount(value.prompt_cache_hit_tokens) ? { cacheReadTokens: value.prompt_cache_hit_tokens } : {}),
  };
}

const isRefusal = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false && value !== '';

export async function streamChat(options: StreamChatOptions): Promise<ChatResult> {
  const { apiKey, messages, settings, signal, onDelta, fetchImpl = globalThis.fetch } = options;
  const outgoing = buildMessages(messages, settings.contextMessageLimit);
  if (!outgoing.length) throw new DeepSeekError('invalid_request');
  const maxTokens = Number.isFinite(settings.maxOutputTokens)
    ? Math.max(1, Math.min(4096, Math.floor(settings.maxOutputTokens))) : 4096;
  const response = await request('/chat/completions', apiKey, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: settings.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
      messages: outgoing,
      thinking: { type: settings.thinking ? 'enabled' : 'disabled' },
      safety_check: { level: 'high' },
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
  }, fetchImpl);

  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    throw new DeepSeekError('protocol');
  }

  let done = false;
  let refused = false;
  let finishReason = '';
  let usage: TokenUsage | undefined;
  const refuse = () => {
    if (!refused) onDelta({ refused: true });
    refused = true;
    finishReason = 'content_filter';
  };
  const parser = new SSEParser((data, event) => {
    if (done) return;
    if (event === 'error') throw streamError(undefined);
    if (data.trim() === '[DONE]') {
      done = true;
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch { throw new DeepSeekError('protocol'); }
    if (!record(payload)) throw new DeepSeekError('protocol');
    if (payload.error || payload.type === 'error') throw streamError(payload);
    usage = readUsage(payload.usage) ?? usage;
    if (isRefusal(payload.refusal)) refuse();
    if (!Array.isArray(payload.choices)) return;
    // Only the requested single completion is consumed.
    const choice = payload.choices.find((item: unknown) => record(item) && (item.index === 0 || item.index === undefined));
    if (!record(choice)) return;
    const delta = record(choice.delta) ? choice.delta : {};
    if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'refusal'
      || isRefusal(choice.refusal) || isRefusal(delta.refusal)) refuse();
    if (choice.finish_reason != null && !refused) {
      if (choice.finish_reason === 'insufficient_system_resource') throw new DeepSeekError('server');
      if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'length') {
        throw new DeepSeekError('protocol');
      }
      finishReason = choice.finish_reason;
    }
    if (refused) return;
    const change: ChatDelta = {};
    if (typeof delta.content === 'string' && delta.content) change.content = delta.content;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      change.reasoning = delta.reasoning_content;
    }
    if (change.content !== undefined || change.reasoning !== undefined) onDelta(change);
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (!done) {
      assertNotAborted(signal);
      const chunk = await reader.read();
      assertNotAborted(signal);
      if (chunk.done) {
        parser.push(decoder.decode(), true);
        break;
      }
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    // A natural socket close is not proof that generation completed.
    if (!done || !finishReason) throw new DeepSeekError('interrupted');
    return { usage, finishReason };
  } catch (error) {
    throw safeError(error, signal, true);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await reader.cancel(); } catch { /* Cleanup never exposes transport errors. */ }
    reader.releaseLock();
  }
}

export async function getBalance(
  apiKey: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Balance> {
  const response = await request('/user/balance', apiKey, { method: 'GET', signal }, fetchImpl);
  let payload: unknown;
  try { payload = await response.json(); }
  catch {
    if (signal?.aborted) throw new DeepSeekError('aborted');
    throw new DeepSeekError('protocol');
  }
  assertNotAborted(signal);
  if (!record(payload) || typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    throw new DeepSeekError('protocol');
  }
  const balances = payload.balance_infos.filter((item: unknown): item is Record<string, unknown> =>
    record(item) && typeof item.currency === 'string' && /^[A-Z]{3}$/.test(item.currency)
    && typeof item.total_balance === 'string' && /^\d+(?:\.\d+)?$/.test(item.total_balance)
    && Number.isFinite(Number(item.total_balance)));
  // Different currencies must not be added together. Prefer CNY for this app.
  const balance = balances.find((item) => item.currency === 'CNY') ?? balances[0];
  if (!balance) throw new DeepSeekError('protocol');
  return {
    available: payload.is_available,
    total: balance.total_balance as string,
    currency: balance.currency as string,
  };
}
