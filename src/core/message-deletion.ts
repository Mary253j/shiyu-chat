import type { Conversation, Message } from './types';

export interface MessageDeletionResult {
  conversation: Conversation;
  deletedCount: number;
  originalDataDropped: boolean;
}

export const ORIGINAL_DATA_REMOVED_WARNING = '删除消息后，因该会话的原始导入资料格式无法安全识别，已移除这份原始副本以防备份恢复已删除正文；其他可见消息仍然保留。';

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

function sourceId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() && value.length <= 500) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function sourceRole(value: RecordValue): Message['role'] | null {
  const role = value.role ?? (isRecord(value.author) ? value.author.role : undefined);
  if (typeof role !== 'string') return null;
  const normalized = role.toLowerCase();
  return normalized === 'user' || normalized === 'assistant' ? normalized : null;
}

function hasKnownMessageContent(value: RecordValue): boolean {
  if (value.fragments !== undefined) return Array.isArray(value.fragments);
  const content = value.content ?? value.text;
  return typeof content === 'string' || Array.isArray(content)
    || (isRecord(content) && (typeof content.text === 'string' || Array.isArray(content.parts)));
}

function validOptionalId(value: unknown): boolean { return value === null || sourceId(value) !== null; }
function validTime(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

/** Rebuild selected source nodes from structural fields, never a payload denylist. */
function emptySourceMessage(source: RecordValue, role: Message['role']): RecordValue {
  const result: RecordValue = {};
  for (const key of ['id', 'message_id', 'parent_id', 'parentId', 'parent']) {
    if (hasOwn(source, key) && validOptionalId(source[key])) result[key] = source[key];
  }
  if (Array.isArray(source.children) && source.children.every(value => sourceId(value) !== null)) {
    result.children = source.children;
  }
  for (const key of ['inserted_at', 'created_at', 'createdAt', 'create_time', 'timestamp', 'updated_at', 'update_time']) {
    if (hasOwn(source, key) && validTime(source[key])) result[key] = source[key];
  }
  result.role = typeof source.role === 'string' && sourceRole(source) === role ? source.role : role;
  if (isRecord(source.author)) result.author = { role };
  if (typeof source.thinking_enabled === 'boolean') result.thinking_enabled = source.thinking_enabled;
  if (typeof source.search_enabled === 'boolean') result.search_enabled = source.search_enabled;
  if (Number.isSafeInteger(source.accumulated_token_usage) && Number(source.accumulated_token_usage) >= 0) {
    result.accumulated_token_usage = source.accumulated_token_usage;
  }
  // An empty node preserves graph topology while containing no former answer,
  // thought, filename, error text, nested message, or future payload alias.
  result.status = 'FINISHED';
  result.content = '';
  result.fragments = [];
  result.contextEligible = false;
  return result;
}

function redactOriginalData(originalData: unknown, removed: Map<string, Message>): { value?: unknown; dropped: boolean } {
  if (originalData === undefined) return { dropped: false };
  if (!isRecord(originalData)) return { dropped: true };
  // Ambiguous containers cannot be safely interpreted as one source format.
  if (hasOwn(originalData, 'messages') && hasOwn(originalData, 'mapping')) return { dropped: true };
  if (Array.isArray(originalData.messages)) {
    const ids = new Set<string>();
    const nodes: { node: RecordValue; id: string; role: Message['role'] }[] = [];
    for (let index = 0; index < originalData.messages.length; index++) {
      const node: unknown = originalData.messages[index];
      if (!isRecord(node)) return { dropped: true };
      // Same precedence and synthetic index IDs as the legacy importer. Keep
      // empty nodes in place so later deletions never shift synthetic IDs.
      const id = sourceId(node.id ?? node.message_id ?? `message-${index}`);
      const role = sourceRole(node);
      if (id === null || role === null || ids.has(id) || !hasKnownMessageContent(node)) return { dropped: true };
      ids.add(id);
      if (removed.has(id) && removed.get(id)!.role !== role) return { dropped: true };
      nodes.push({ node, id, role });
    }
    let changed = false;
    const messages = nodes.map(({ node, id, role }) => {
      if (!removed.has(id)) return node;
      changed = true;
      return emptySourceMessage(node, role);
    });
    return { value: changed ? { ...originalData, messages } : originalData, dropped: false };
  }
  if (isRecord(originalData.mapping)) {
    const mapping = originalData.mapping;
    const nodes: { key: string; node: RecordValue; role: Message['role'] | null }[] = [];
    for (const key of Object.keys(mapping)) {
      const value: unknown = mapping[key];
      if (!isRecord(value) || sourceId(value.id ?? key) !== key
        || (value.parent !== undefined && !validOptionalId(value.parent))
        || (value.children !== undefined && (!Array.isArray(value.children) || !value.children.every(child => sourceId(child) !== null)))
        || (value.message !== null && !isRecord(value.message))) return { dropped: true };
      const role = isRecord(value.message) ? sourceRole(value.message) : null;
      if (value.message !== null && (role === null || !hasKnownMessageContent(value.message as RecordValue))) return { dropped: true };
      if (removed.has(key) && removed.get(key)!.role !== role) return { dropped: true };
      nodes.push({ key, node: value, role });
    }
    if (!nodes.some(({ key }) => removed.has(key))) return { value: originalData, dropped: false };
    // Object.fromEntries creates own data properties, including '__proto__'.
    const nextMapping = Object.fromEntries(nodes.map(({ key, node, role }) => {
      if (!removed.has(key)) return [key, node];
      const redacted: RecordValue = { id: node.id ?? key,
        message: emptySourceMessage(node.message as RecordValue, role!) };
      if (hasOwn(node, 'parent')) redacted.parent = node.parent;
      if (hasOwn(node, 'children')) redacted.children = node.children;
      return [key, redacted];
    }));
    return { value: { ...originalData, mapping: nextMapping }, dropped: false };
  }
  return { dropped: true };
}

function excludedReply(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  return message.contextEligible === false
    || !(message.status === 'complete' || (message.status === 'stopped' && message.contextEligible === true))
    || !message.content.trim();
}

/**
 * Removes precisely the selected visible messages without mutating the source.
 * Boundaries preserve missing-turn information across future deletions/backups.
 * Only the affected conversation/source containers are visited, never the whole
 * library or JSON-stringified copies of large source payloads.
 */
export function deleteConversationMessages(conversation: Conversation, ids: readonly string[], now = Date.now()): MessageDeletionResult {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new Error('删除的消息编号无效。');
  if (!ids.length) return { conversation, deletedCount: 0, originalDataDropped: false };
  const selected = new Set(ids);
  const removed = new Map<string, Message>();
  const seen = new Set<string>();
  for (const message of conversation.messages) {
    if (seen.has(message.id)) throw new Error('消息编号重复，未删除任何消息。');
    seen.add(message.id);
    if (selected.has(message.id)) removed.set(message.id, message);
  }
  if (!removed.size) return { conversation, deletedCount: 0, originalDataDropped: false };
  const revision = conversation.redactionRevision === undefined ? 0 : conversation.redactionRevision;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER
    || !Number.isFinite(now) || now < 0) throw new Error('删除版本或时间无效，未删除任何消息。');

  const excludedUsers = new Set<string>();
  for (let index = 1; index < conversation.messages.length; index++) {
    const message = conversation.messages[index]; const previous = conversation.messages[index - 1];
    if (removed.has(message.id) && excludedReply(message) && !message.contextBoundaryBefore && previous.role === 'user') {
      // Removing a rejected/failed answer must not turn its previously excluded
      // question into a newly eligible standalone user message.
      excludedUsers.add(previous.id);
    }
  }
  const messages: Message[] = [];
  let gap = false;
  for (const message of conversation.messages) {
    if (message.contextBoundaryBefore !== undefined && typeof message.contextBoundaryBefore !== 'boolean') throw new Error('消息边界信息无效，未删除任何消息。');
    if (removed.has(message.id)) { gap = true; continue; }
    const boundary = gap && message.contextBoundaryBefore !== true;
    const exclude = excludedUsers.has(message.id) && message.contextEligible !== false;
    messages.push(boundary || exclude ? { ...message,
      ...(boundary ? { contextBoundaryBefore: true } : {}), ...(exclude ? { contextEligible: false } : {}) } : message);
    gap = false;
  }
  const original = redactOriginalData(conversation.originalData, removed);
  const { originalData: _originalData, ...retained } = conversation;
  const warnings = original.dropped
    ? [...new Set([...(conversation.importWarnings ?? []), ORIGINAL_DATA_REMOVED_WARNING])]
    : conversation.importWarnings;
  return {
    conversation: { ...retained, messages, updatedAt: now, redactionRevision: revision + 1,
      ...(original.value === undefined ? {} : { originalData: original.value }),
      ...(warnings === undefined ? {} : { importWarnings: warnings }) },
    deletedCount: removed.size,
    originalDataDropped: original.dropped,
  };
}
