import { parseMessageAttachments, type MessageAttachment } from './attachments';
import type { ContextUsage, Message, Settings } from './types';

export interface RequestTextPart { type: 'text'; text: string }
export interface RequestFilePart { type: 'file'; file_id: string }
export type RequestMessage =
  | { role: 'user'; content: string | (RequestTextPart | RequestFilePart)[] }
  | { role: 'assistant'; content: string };

export interface ContextPlan {
  messages: RequestMessage[];
  usage: ContextUsage;
}

export const MODEL_CONTEXT_TOKENS = 1_000_000;
export const CONTEXT_SAFETY_RESERVE = 8192;
export const MAX_REQUEST_FILE_REFERENCES = 20;
export const MISSING_ATTACHMENT_PLACEHOLDER = '[原消息仅含附件，本版未迁移附件]';
export const MISSING_ATTACHMENT_REFERENCE = '历史用户曾上传附件，原件未恢复；下一条历史回复仅可作为已有文字参考，不能当作附件全文。';

export type ContextErrorCode = 'invalid_current_message' | 'current_message_too_large'
  | 'attachment_invalid' | 'attachment_expired' | 'attachment_unsupported_model' | 'attachment_limit';

export class ContextPlanError extends Error {
  constructor(readonly code: ContextErrorCode, message: string) {
    super(message);
    this.name = 'ContextPlanError';
  }
}

export function resolveMaxOutputTokens(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(4096, Math.floor(value))) : 4096;
}

/**
 * A conservative text estimate, not an exact tokenizer. A UTF-8 byte is charged
 * as one token, with additional framing allowance and a model-level reserve.
 * Remote files are expanded by DeepSeek; file byte size is NOT a token estimate.
 */
export function estimateTextTokens(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index++;
    } else bytes += 3; // Includes the replacement encoding of unpaired surrogates.
  }
  return bytes;
}

const textEstimates = new WeakMap<Message, { text: string; tokens: number }>();
function messageTextTokens(message: Message): number {
  const cached = textEstimates.get(message);
  if (cached?.text === message.content) return cached.tokens;
  const tokens = estimateTextTokens(message.content);
  textEstimates.set(message, { text: message.content, tokens });
  return tokens;
}

function allowedStatus(message: Message): boolean {
  if (message.contextEligible === false) return false;
  if (message.status === 'complete') return true;
  // Imported partial replies explicitly marked usable are different from local
  // interrupted/length-limited replies and interrupted on-disk streaming saves.
  return message.status === 'stopped' && message.contextEligible === true;
}

function usableUser(message: Message): boolean {
  return message.role === 'user' && allowedStatus(message) && typeof message.content === 'string'
    && (Boolean(message.content.trim()) || Boolean(message.attachments?.length));
}

function usableAssistant(message: Message): boolean {
  return message.role === 'assistant' && allowedStatus(message)
    && typeof message.content === 'string' && Boolean(message.content.trim());
}

function missingAttachmentPrompt(message: Message): boolean {
  // Deliberately narrow: never turn an arbitrary excluded/refused prompt into
  // an invented eligible user message or recover attachment bytes from metadata.
  return message.role === 'user' && message.status === 'complete'
    && message.contextEligible === false && message.content === MISSING_ATTACHMENT_PLACEHOLDER
    && !message.attachments?.length;
}

interface PreparedMessage {
  request: RequestMessage;
  estimatedTextTokens: number;
  fileReferences: number;
  source?: Message;
}

function prepareUser(message: Message): PreparedMessage {
  // Collect capacity information before strict validation. A malformed old
  // attachment outside the selected range must not block a text-only request.
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return {
    request: { role: 'user', content: message.content }, source: message, fileReferences: attachments.length,
    estimatedTextTokens: 64 + messageTextTokens(message)
      + attachments.reduce((sum, attachment) => sum + 48
        + (typeof attachment?.remote?.fileId === 'string' ? estimateTextTokens(attachment.remote.fileId) : 0), 0),
  };
}

function prepareAssistant(message: Message): PreparedMessage {
  return { request: { role: 'assistant', content: message.content }, source: message,
    fileReferences: 0, estimatedTextTokens: 64 + messageTextTokens(message) };
}

function materialize(prepared: PreparedMessage): { request: RequestMessage; attachments: MessageAttachment[] } {
  const source = prepared.source;
  if (prepared.request.role === 'assistant') {
    if (source?.attachments?.length) throw new ContextPlanError('attachment_invalid', '历史回复包含不支持的附件引用，请新开对话或缩小上下文范围。');
    return { request: prepared.request, attachments: [] };
  }
  let attachments: MessageAttachment[] = [];
  if (source?.attachments !== undefined) {
    try { attachments = parseMessageAttachments(source.attachments); }
    catch { throw new ContextPlanError('attachment_invalid', '附件引用无效，请重新上传，或缩小上下文范围后重试。'); }
  }
  return {
    request: attachments.length ? { role: 'user', content: [
      { type: 'text', text: source!.content },
      ...attachments.map(attachment => ({ type: 'file' as const, file_id: attachment.remote.fileId })),
    ] } : prepared.request,
    attachments,
  };
}

interface HistoryUnit {
  messages: PreparedMessage[];
  estimatedTextTokens: number;
  fileReferences: number;
  missingAttachmentSummary: boolean;
}

function unit(messages: PreparedMessage[], missingAttachmentSummary = false): HistoryUnit {
  return {
    messages, missingAttachmentSummary,
    estimatedTextTokens: messages.reduce((sum, message) => sum + message.estimatedTextTokens, 0),
    fileReferences: messages.reduce((sum, message) => sum + message.fileReferences, 0),
  };
}

function historyUnits(messages: Message[]): HistoryUnit[] {
  const units: HistoryUnit[] = [];
  let pendingUser: Message | undefined;
  for (let index = 0; index < messages.length - 1; index++) {
    const message = messages[index];
    if (message.role === 'user') {
      // A prior unanswered user message is still a real user-provided fact.
      if (pendingUser && usableUser(pendingUser)) units.push(unit([prepareUser(pendingUser)]));
      pendingUser = message;
    } else if (message.role === 'assistant') {
      if (pendingUser && usableAssistant(message)) {
        if (usableUser(pendingUser)) units.push(unit([prepareUser(pendingUser), prepareAssistant(message)]));
        else if (missingAttachmentPrompt(pendingUser) && message.status === 'complete') {
          units.push(unit([
            { request: { role: 'user', content: MISSING_ATTACHMENT_REFERENCE }, fileReferences: 0,
              estimatedTextTokens: 64 + estimateTextTokens(MISSING_ATTACHMENT_REFERENCE) },
            prepareAssistant(message),
          ], true));
        }
      }
      // A failed/refused/ineligible assistant removes its associated user too.
      // Do not pair that user with a later assistant or revive it as an orphan.
      pendingUser = undefined;
    } else {
      // Imported/runtime system/tool objects cannot enter or bridge a turn.
      pendingUser = undefined;
    }
  }
  if (pendingUser && usableUser(pendingUser)) units.push(unit([prepareUser(pendingUser)]));
  return units;
}

/**
 * Plans the exact request body and the history usage recorded beside its reply.
 * Undefined contextMode (older installations) means auto, even with limit=40.
 * Only the caller's active conversation/branch is examined; originalData,
 * reasoning, and other app metadata are never promoted into model instructions.
 */
export function buildContextPlan(messages: Message[], settings: Settings): ContextPlan {
  const current = messages.at(-1);
  if (!current || current.role !== 'user' || current.status !== 'complete' || !usableUser(current)) {
    throw new ContextPlanError('invalid_current_message', '当前消息没有可发送的文字或附件，请重新输入。');
  }
  const currentMessage = prepareUser(current);
  const inputBudget = MODEL_CONTEXT_TOKENS - CONTEXT_SAFETY_RESERVE - resolveMaxOutputTokens(settings.maxOutputTokens);
  if (currentMessage.estimatedTextTokens > inputBudget) {
    throw new ContextPlanError('current_message_too_large', '当前消息超过可用上下文容量，请分段发送；已有记录未修改。');
  }
  if (currentMessage.fileReferences > MAX_REQUEST_FILE_REFERENCES) {
    throw new ContextPlanError('attachment_limit', '单次请求最多引用 20 个文件，请减少当前附件后重试。');
  }
  const units = historyUnits(messages);
  const eligibleHistoryMessages = units.reduce((sum, item) => sum + item.messages.length, 0);
  let includedHistoryMessages = eligibleHistoryMessages;
  let textTokens = units.reduce((sum, item) => sum + item.estimatedTextTokens, currentMessage.estimatedTextTokens);
  let fileReferences = units.reduce((sum, item) => sum + item.fileReferences, currentMessage.fileReferences);
  const recentLimit = Number.isFinite(settings.contextMessageLimit)
    ? Math.max(1, Math.min(201, Math.floor(settings.contextMessageLimit))) : 40;
  const historyLimit = settings.contextMode === 'recent' ? recentLimit - 1 : Number.POSITIVE_INFINITY;
  const reasons = new Set<string>();
  let start = 0;
  while (start < units.length && (includedHistoryMessages > historyLimit || textTokens > inputBudget
    || fileReferences > MAX_REQUEST_FILE_REFERENCES)) {
    if (includedHistoryMessages > historyLimit) reasons.add('已按“最近消息”设置省略较早历史。');
    if (textTokens > inputBudget) reasons.add('历史文字较长，已为回复预留空间并省略较早的完整历史单元。');
    if (fileReferences > MAX_REQUEST_FILE_REFERENCES) reasons.add('单次请求最多引用 20 个文件，已省略较早的完整历史单元。');
    const removed = units[start++];
    includedHistoryMessages -= removed.messages.length;
    textTokens -= removed.estimatedTextTokens;
    fileReferences -= removed.fileReferences;
  }
  const selected = units.slice(start);
  const prepared = [...selected.flatMap(item => item.messages), currentMessage].map(materialize);
  if (fileReferences && settings.model !== 'deepseek-flash') {
    throw new ContextPlanError('attachment_unsupported_model', '附件仅支持 Flash 模型，请切换到 Flash 后重试。');
  }
  const now = Math.floor(Date.now() / 1000);
  if (prepared.some(message => message.attachments.some(attachment => attachment.remote.expiresAt !== undefined && attachment.remote.expiresAt <= now))) {
    throw new ContextPlanError('attachment_expired', '当前或历史附件已过期，请重新上传，或缩小上下文范围后重试。');
  }
  if (selected.some(item => item.missingAttachmentSummary)) reasons.add('原附件未恢复；已携带此前的文字回复作参考，不能视为附件全文。');
  if (fileReferences) reasons.add('附件内容由服务方解析，无法在本机准确估算长度；若请求超限，请减少附件或缩小上下文范围。');
  const omittedHistoryMessages = eligibleHistoryMessages - includedHistoryMessages;
  return {
    messages: prepared.map(message => message.request),
    usage: { includedHistoryMessages, eligibleHistoryMessages, omittedHistoryMessages,
      truncated: omittedHistoryMessages > 0, ...(reasons.size ? { reason: [...reasons].join('') } : {}) },
  };
}

/** Compatibility helper: explicit recent mode, with the same eligibility rules. */
export function buildMessages(messages: Message[], contextMessageLimit: number): RequestMessage[] {
  try {
    return buildContextPlan(messages, { model: 'deepseek-flash', thinking: false,
      maxOutputTokens: 4096, contextMode: 'recent', contextMessageLimit }).messages;
  } catch (error) {
    if (error instanceof ContextPlanError && error.code === 'invalid_current_message') return [];
    throw error;
  }
}
