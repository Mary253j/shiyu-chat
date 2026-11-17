import { Inflate, strFromU8, strToU8 } from 'fflate';
import type { AppState, ContextUsage, Conversation, Message, MessageStatus } from './types';
import { parseMessageAttachments } from './attachments';

/**
 * Independent reader of DeepSeek's documented v3 archive format.
 * Format reference (MIT, Copyright 2026 DeepSeek):
 * https://github.com/deepseek-ai/chat-demo/tree/main/src/services/chat/history
 * No upstream implementation is copied here. Keep the complete source session
 * in originalData: this importer cannot restore ZIP attachment bytes or tool blocks.
 */
export interface ImportPreview {
  conversations: Conversation[];
  warnings: string[];
  messageCount: number;
  sourceLabel: string;
}

export const HISTORY_LIMITS = {
  inputBytes: 20 * 1024 * 1024,
  expandedBytes: 50 * 1024 * 1024,
  entries: 5000,
  conversations: 2000,
  messages: 100000,
  messageCharacters: 1_000_000,
  depth: 64,
  jsonNodes: 3_000_000,
} as const;

type Row = Record<string, unknown>;
type Budget = { messages: number };
type Node = { id: string; parent: string | null; message: Message | null };
type ZipEntry = { name: string; compressed: number; expanded: number; crc: number; method: number; flags: number; offset: number };

function fail(message: string): never { throw new Error(`无法导入：${message}`); }
function row(value: unknown, label: string): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label}不是有效对象。`);
  return value as Row;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label}不是有效列表。`);
  return value;
}
function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label}不是有效文字。`);
  if (value.length > HISTORY_LIMITS.messageCharacters) fail(`${label}超过单条文字长度限制。`);
  return value;
}
function idValue(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && value.trim() && value.length <= 500) return value;
  return fail(`${label}缺失或无效。`);
}
function timeValue(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number'
    ? (value > 0 && value < 100_000_000_000 ? value * 1000 : value)
    : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8_640_000_000_000_000) fail(`${label}无效。`);
  return parsed;
}
function requiredTime(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) fail(`${label}不是 UTC 时间。`);
  const fixed = value.replace(/(?:\.(\d+))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0').slice(0, 3)}Z`);
  const result = Date.parse(fixed);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== fixed) fail(`${label}无效。`);
  return result;
}
function checkBudget(budget: Budget, count: number): void {
  budget.messages += count;
  if (budget.messages > HISTORY_LIMITS.messages) fail(`消息总数超过 ${HISTORY_LIMITS.messages} 条。`);
}
function warn(warnings: Set<string>, value: string): void { warnings.add(value); }

function parseJson(value: string, label: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(value.replace(/^\uFEFF/, '')); }
  catch { return fail(`${label}的 JSON 已损坏。`); }
  function* children(value: object): Generator<unknown> {
    if (Array.isArray(value)) { yield* value; return; }
    // Do not allocate Object.values + one pending object per property: a flat
    // malicious JSON array would otherwise amplify memory before count checks.
    for (const key in value) if (Object.hasOwn(value, key)) yield (value as Row)[key];
  }
  const pending: { iterator: Iterator<unknown>; depth: number }[] = [{ iterator: [parsed].values(), depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const frame = pending[pending.length - 1]; const next = frame.iterator.next();
    if (next.done) { pending.pop(); continue; }
    if (++visited > HISTORY_LIMITS.jsonNodes) fail(`${label}包含过多数据节点。`);
    if (frame.depth > HISTORY_LIMITS.depth) fail(`${label}嵌套过深。`);
    if (next.value && typeof next.value === 'object') pending.push({ iterator: children(next.value), depth: frame.depth + 1 });
  }
  return parsed;
}

// Two independent integer hashes keep missing-ID legacy imports deterministic.
// Actual provider IDs are always preferred; no random/time-based import IDs.
function stableHash(value: string): string {
  let a = 0x811c9dc5; let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  crcTable[i] = value >>> 0;
}
function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
function safeZipPath(value: string): string {
  const normalized = value.normalize('NFC');
  if (!normalized || normalized.includes('\\') || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) fail('ZIP 包含不安全的文件路径。');
  const parts = normalized.split('/');
  if (parts.some((part, i) => part === '.' || part === '..' || (!part && i !== parts.length - 1))) fail('ZIP 包含不安全的文件路径。');
  return normalized;
}
function decodeUtf8(value: Uint8Array, label: string): string {
  const decoded = strFromU8(value);
  // Round-trip rejects malformed UTF-8 without relying on TextDecoder in RN.
  const encoded = strToU8(decoded);
  if (encoded.length !== value.length || encoded.some((byte, i) => byte !== value[i])) fail(`${label}不是有效 UTF-8。`);
  return decoded;
}

function readZip(input: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let end = -1;
  for (let at = input.length - 22; at >= Math.max(0, input.length - 65557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === input.length) { end = at; break; }
  }
  if (end < 0) fail('ZIP 包不完整。');
  const count = u16(end + 10); const directorySize = u32(end + 12); const directory = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) fail('不支持分卷 ZIP。');
  if (count === 65535 || directory === 0xffffffff || directorySize === 0xffffffff) fail('不支持 ZIP64。');
  if (count > HISTORY_LIMITS.entries) fail('ZIP 内文件数量过多。');
  if (directory + directorySize !== end) fail('ZIP 目录已损坏。');
  const entries: ZipEntry[] = []; const seen = new Set<string>();
  let at = directory; let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) fail('ZIP 目录已损坏。');
    const nameLength = u16(at + 28); const extra = u16(at + 30); const comment = u16(at + 32);
    if (at + 46 + nameLength + extra + comment > end) fail('ZIP 文件名已损坏。');
    const name = safeZipPath(decodeUtf8(input.subarray(at + 46, at + 46 + nameLength), 'ZIP 文件名'));
    const entry: ZipEntry = { name, flags: u16(at + 8), method: u16(at + 10), crc: u32(at + 16), compressed: u32(at + 20), expanded: u32(at + 24), offset: u32(at + 42) };
    if (entry.flags & 1 || entry.flags & 0x40) fail('不支持加密 ZIP。');
    if (entry.method !== 0 && entry.method !== 8) fail('不支持该 ZIP 压缩方式。');
    if (u16(at + 34) || [entry.compressed, entry.expanded, entry.offset].includes(0xffffffff)) fail('不支持 ZIP64 或分卷 ZIP。');
    if (seen.has(name)) fail(`ZIP 出现重复路径：${name}`);
    seen.add(name); total += entry.expanded;
    if (total > HISTORY_LIMITS.expandedBytes) fail('解压后的总大小超过 50 MiB。');
    entries.push(entry); at += 46 + nameLength + extra + comment;
  }
  if (at !== end) fail('ZIP 目录长度不匹配。');
  entries.sort((a, b) => a.offset - b.offset);
  if (entries[0]?.name !== 'manifest.json' || entries[0].offset !== 0) fail('ZIP 首个文件必须为 manifest.json。');
  const result = new Map<string, Uint8Array>();
  let previousEnd = 0;
  for (const entry of entries) {
    const offset = entry.offset;
    if (offset !== previousEnd || offset + 30 > directory || u32(offset) !== 0x04034b50) fail('ZIP 本地文件头已损坏、缺失或重叠。');
    const nameLength = u16(offset + 26); const extraLength = u16(offset + 28); const dataStart = offset + 30 + nameLength + extraLength;
    if (dataStart + entry.compressed > directory) fail('ZIP 文件内容已截断。');
    const localName = safeZipPath(decodeUtf8(input.subarray(offset + 30, offset + 30 + nameLength), 'ZIP 文件名'));
    if (localName !== entry.name || u16(offset + 8) !== entry.method || u16(offset + 6) !== entry.flags) fail('ZIP 文件头与目录不一致。');
    if (!(entry.flags & 8) && (u32(offset + 14) !== entry.crc || u32(offset + 18) !== entry.compressed || u32(offset + 22) !== entry.expanded)) fail('ZIP 文件大小或校验信息不一致。');
    const compressed = input.subarray(dataStart, dataStart + entry.compressed);
    let output: Uint8Array;
    if (entry.method === 0) {
      if (compressed.length !== entry.expanded) fail('ZIP 未压缩文件大小不一致。');
      output = compressed;
    } else {
      output = new Uint8Array(entry.expanded);
      let written = 0;
      const inflater = new Inflate((chunk) => {
        if (written + chunk.length > output.length) fail('ZIP 实际解压大小超过声明，已停止导入。');
        output.set(chunk, written); written += chunk.length;
      });
      try {
        for (let pos = 0; pos < compressed.length; pos += 4096) inflater.push(compressed.subarray(pos, pos + 4096), pos + 4096 >= compressed.length);
        if (!compressed.length) inflater.push(compressed, true);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('无法导入：')) throw error;
        fail('ZIP 压缩内容已损坏。');
      }
      if (written !== entry.expanded) fail('ZIP 解压后的文件大小不一致。');
    }
    if (crc32(output) !== entry.crc) fail(`ZIP 文件校验失败：${entry.name}`);
    // Attachments are integrity-checked but not retained in memory after reading.
    if (entry.name.endsWith('.json') && !entry.name.includes('_files/')) result.set(entry.name, output);
    else result.set(entry.name, new Uint8Array());
    previousEnd = dataStart + entry.compressed;
    if (entry.flags & 8) {
      // Streaming ZIP writers append a data descriptor after the payload.
      if (previousEnd + 12 > directory) fail('ZIP 数据描述符已截断。');
      if (u32(previousEnd) === 0x08074b50) previousEnd += 4;
      if (previousEnd + 12 > directory || u32(previousEnd) !== entry.crc || u32(previousEnd + 4) !== entry.compressed || u32(previousEnd + 8) !== entry.expanded) fail('ZIP 数据描述符与目录不一致。');
      previousEnd += 12;
    }
  }
  if (previousEnd !== directory) fail('ZIP 包含未记录的文件数据。');
  return result;
}

const statusMap: Record<string, MessageStatus> = {
  FINISHED: 'complete', COMPLETE: 'complete', COMPLETED: 'complete', DONE: 'complete',
  WIP: 'stopped', INCOMPLETE: 'stopped', STOPPED: 'stopped', STREAMING: 'stopped',
  FAILED: 'error', ERROR: 'error', CONTEXT_LENGTH_EXCEEDED: 'error', TIMEOUT: 'error',
  CONTENT_FILTER: 'refused', REFUSED: 'refused',
};

function messageStatus(value: unknown, required: boolean): MessageStatus {
  if (value === undefined && !required) return 'complete';
  if (typeof value !== 'string' || !Object.hasOwn(statusMap, value.toUpperCase())) fail('消息状态不受支持。');
  return statusMap[value.toUpperCase()];
}

function fragments(value: unknown, warnings: Set<string>): { content: string; reasoning: string; template: boolean; missingAttachment: boolean } {
  let content = ''; let reasoning = ''; let template = false; let missingAttachment = false;
  for (const item of list(value, '消息片段')) {
    const part = row(item, '消息片段'); const type = textValue(part.type, '消息片段类型');
    if (['REQUEST', 'RESPONSE', 'TEMPLATE_RESPONSE'].includes(type)) {
      content += textValue(part.content, '消息正文');
      if (type === 'TEMPLATE_RESPONSE') template = true;
    } else if (type === 'THINK') reasoning += textValue(part.content, '思考正文');
    else if (type === 'FILE') {
      for (const value of list(part.files, '附件列表')) {
        const file = row(value, '附件'); textValue(file.file_name, '附件名称');
        if (typeof file.file_size !== 'number' || !Number.isSafeInteger(file.file_size) || file.file_size < 0) fail('附件大小无效。');
        if (file.export_path !== null && file.export_path !== undefined) safeZipPath(textValue(file.export_path, '附件路径'));
      }
      missingAttachment = true;
      warn(warnings, '附件只保留原始元数据，图片和文档原件暂未迁移，也不会发送给模型；需要时请重新上传。');
    } else {
      // Preserve every unrendered fragment in originalData; never silently discard.
      warn(warnings, `历史中的 ${type} 片段已保留在原始备份中，本版不展示或回传这些内容。`);
    }
  }
  textValue(content, '合并后的正文'); textValue(reasoning, '合并后的思考');
  return { content, reasoning, template, missingAttachment };
}

function legacyContent(value: unknown, warnings: Set<string>): string {
  if (typeof value === 'string') return textValue(value, '消息正文');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Row;
    if (typeof object.text === 'string') return textValue(object.text, '消息正文');
    if (Array.isArray(object.parts)) return legacyContent(object.parts, warnings);
  }
  if (Array.isArray(value)) return value.map((part) => {
    if (typeof part === 'string') return textValue(part, '消息正文');
    const object = row(part, '消息内容块');
    if ((object.type === 'text' || object.type === 'input_text' || object.type === 'output_text') && typeof object.text === 'string') return textValue(object.text, '消息正文');
    if (['image', 'image_url', 'input_image', 'file', 'audio'].includes(String(object.type))) {
      warn(warnings, '附件只保留原始元数据，图片和文档原件暂未迁移，也不会发送给模型；需要时请重新上传。');
      return '';
    }
    return fail('旧版消息包含无法识别的内容块，未导入任何会话。');
  }).join('\n');
  return fail('旧版消息缺少可识别的正文。');
}

function normalizeMessage(raw: Row, id: string, fallback: number, official: boolean, warnings: Set<string>): Message {
  const author = raw.author === undefined ? undefined : row(raw.author, '消息作者');
  const role = String(raw.role ?? author?.role ?? '').toLowerCase();
  if (role !== 'user' && role !== 'assistant') fail(`不支持消息角色 ${role || '（空）'}，未导入任何会话。`);
  const status = messageStatus(raw.status, official);
  const createdAt = official ? requiredTime(raw.inserted_at, '消息时间') : timeValue(raw.createdAt ?? raw.inserted_at ?? raw.created_at ?? raw.create_time ?? raw.timestamp, fallback, '消息时间');
  let content: string; let reasoning: string | undefined; let template = false; let missingAttachment = false;
  if (raw.fragments !== undefined) ({ content, reasoning, template, missingAttachment } = fragments(raw.fragments, warnings));
  else {
    if (official) fail('官方消息缺少 fragments。');
    content = legacyContent(raw.content ?? raw.text, warnings);
    if (raw.reasoning !== undefined || raw.reasoning_content !== undefined) reasoning = textValue(raw.reasoning ?? raw.reasoning_content, '思考正文');
    if (raw.files !== undefined || raw.attachments !== undefined) {
      list(raw.files ?? raw.attachments, '附件列表'); missingAttachment = true;
      warn(warnings, '附件只保留原始元数据，图片和文档原件暂未迁移，也不会发送给模型；需要时请重新上传。');
    }
  }
  if (missingAttachment && !content.trim()) content = '[原消息仅含附件，本版未迁移附件]';
  if (template) warn(warnings, '服务端提示、失败和拒答消息保留用于查看，不作为续聊上下文。');
  return {
    id, role, content: textValue(content, '消息正文'), createdAt, status,
    ...(reasoning ? { reasoning } : {}),
    contextEligible: status !== 'error' && status !== 'refused' && !template && Boolean(content.trim()) && !(missingAttachment && content.startsWith('[原消息仅含附件')),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  };
}

function activeBranch(nodes: Node[], current: unknown, requireCurrent: boolean, warnings: Set<string>): Message[] {
  const byId = new Map<string, Node>();
  for (const node of nodes) {
    if (byId.has(node.id)) fail('同一会话出现重复消息 ID。');
    byId.set(node.id, node);
  }
  const parents = new Set<string>(); const finished = new Set<string>();
  for (const node of nodes) {
    if (node.parent !== null) {
      if (!byId.has(node.parent)) fail('消息引用了不存在的父消息。');
      parents.add(node.parent);
    }
    const path = new Set<string>(); let cursor: Node | undefined = node;
    while (cursor && !finished.has(cursor.id)) {
      if (path.has(cursor.id)) fail('消息树存在循环引用。');
      path.add(cursor.id);
      cursor = cursor.parent === null ? undefined : byId.get(cursor.parent);
    }
    for (const id of path) finished.add(id);
  }
  if (!nodes.length) return [];
  let active: string;
  if (current !== undefined && current !== null) active = idValue(current, '活动消息 ID');
  else {
    const leaves = nodes.filter((node) => !parents.has(node.id));
    if (requireCurrent || leaves.length !== 1) fail('存在多个分支但缺少有效活动消息，不能猜测续聊分支。');
    active = leaves[0].id;
  }
  if (!byId.has(active)) fail('活动消息不存在。');
  const branch: Message[] = []; let cursor: Node | undefined = byId.get(active);
  while (cursor) {
    if (cursor.message) branch.push(cursor.message);
    cursor = cursor.parent === null ? undefined : byId.get(cursor.parent);
  }
  branch.reverse();
  if (branch.length < nodes.filter((node) => node.message).length) warn(warnings, '仅当前活动分支用于续聊；其他分支完整保留在原始备份中，暂不支持切换。');
  // A failed assistant reply must not leave its user prompt in future context.
  for (let i = 0; i < branch.length; i++) {
    if (branch[i].role === 'assistant' && !branch[i].contextEligible && i && branch[i - 1].role === 'user') branch[i - 1].contextEligible = false;
  }
  return branch;
}

function importedConversation(value: unknown, official: boolean, budget: Budget): Conversation {
  const raw = row(value, '会话'); const warnings = new Set<string>();
  const providerId = raw.id ?? raw.conversation_id ?? raw.session_id;
  const sourceId = `deepseek:${providerId === undefined ? `legacy-${stableHash(JSON.stringify(raw))}` : idValue(providerId, '会话 ID')}`;
  if (providerId === undefined) warn(warnings, '该旧版会话没有来源 ID，使用内容指纹去重；内容改变后可能导入为新会话。');
  const createdAt = official ? requiredTime(raw.inserted_at, '会话创建时间') : timeValue(raw.createdAt ?? raw.inserted_at ?? raw.created_at ?? raw.create_time, 0, '会话创建时间');
  const updatedAt = official ? requiredTime(raw.updated_at, '会话更新时间') : timeValue(raw.updatedAt ?? raw.updated_at ?? raw.update_time, createdAt, '会话更新时间');
  const nodes: Node[] = [];
  if (raw.mapping !== undefined) {
    if (official) fail('官方 ZIP 会话格式不正确。');
    const mapping = row(raw.mapping, '消息树'); checkBudget(budget, Object.keys(mapping).length);
    for (const [key, value] of Object.entries(mapping)) {
      const item = row(value, '消息树节点'); const id = idValue(item.id ?? key, '消息节点 ID');
      if (id !== key) fail('消息树键与消息 ID 不一致。');
      const parent = item.parent === null || item.parent === undefined ? null : idValue(item.parent, '父消息 ID');
      nodes.push({ id, parent, message: item.message === null ? null : normalizeMessage(row(item.message, '消息'), id, createdAt, false, warnings) });
      if (item.children !== undefined) {
        for (const child of list(item.children, '子消息列表')) {
          const childId = idValue(child, '子消息 ID'); const target = row(mapping[childId], '子消息');
          if (String(target.parent) !== id) fail('消息树父子引用不一致。');
        }
      }
    }
  } else {
    const messages = list(raw.messages, '会话消息'); checkBudget(budget, messages.length);
    const rows = messages.map((value) => row(value, '消息'));
    const hasParents = rows.some((item) => Object.hasOwn(item, 'parent_id') || Object.hasOwn(item, 'parentId') || Object.hasOwn(item, 'parent'));
    for (let index = 0; index < rows.length; index++) {
      const item = rows[index];
      const id = idValue(item.id ?? item.message_id ?? (!official ? `message-${index}` : undefined), '消息 ID');
      let parent: string | null = index ? nodes[index - 1].id : null;
      if (hasParents || official) {
        if (!Object.hasOwn(item, 'parent_id') && !Object.hasOwn(item, 'parentId') && !Object.hasOwn(item, 'parent')) fail('消息缺少父节点信息。');
        const parentValue = Object.hasOwn(item, 'parent_id') ? item.parent_id : Object.hasOwn(item, 'parentId') ? item.parentId : item.parent;
        parent = parentValue === null ? null : idValue(parentValue, '父消息 ID');
      }
      nodes.push({ id, parent, message: normalizeMessage(item, id, createdAt, official, warnings) });
    }
  }
  const messages = activeBranch(nodes, raw.current_message_id ?? raw.current_node ?? raw.currentMessageId, official, warnings);
  if (official) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (!/^\d+$/.test(node.id) || !Number.isSafeInteger(Number(node.id))) fail('官方消息 ID 必须为非负整数。');
      if (node.parent === null) {
        if (node.message?.role !== 'user') fail('消息树根节点必须是用户消息。');
      } else if (Number(node.parent) >= Number(node.id) || byId.get(node.parent)?.message?.role === node.message?.role) fail('官方消息树顺序或角色不正确。');
    }
  }
  return {
    id: `import-${sourceId}`, sourceId,
    title: raw.title === null || raw.title === undefined || raw.title === '' ? '导入的对话' : textValue(raw.title, '会话标题'),
    createdAt, updatedAt, messages, originalData: raw,
    ...(warnings.size ? { importWarnings: [...warnings] } : {}),
  };
}

function backupContextUsage(value: unknown): ContextUsage {
  const item = row(value, '上下文用量');
  for (const key of ['includedHistoryMessages', 'eligibleHistoryMessages', 'omittedHistoryMessages']) {
    if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0) fail('备份上下文用量无效。');
  }
  if (typeof item.truncated !== 'boolean'
    || Number(item.includedHistoryMessages) + Number(item.omittedHistoryMessages) !== item.eligibleHistoryMessages
    || (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 1000))) fail('备份上下文用量无效。');
  return { includedHistoryMessages: item.includedHistoryMessages as number,
    eligibleHistoryMessages: item.eligibleHistoryMessages as number,
    omittedHistoryMessages: item.omittedHistoryMessages as number, truncated: item.truncated,
    ...(item.reason === undefined ? {} : { reason: item.reason as string }) };
}

function backupConversation(value: unknown, budget: Budget): Conversation {
  const raw = row(value, '备份会话'); const id = idValue(raw.id, '备份会话 ID');
  const createdAt = raw.createdAt; const updatedAt = raw.updatedAt;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number' || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || createdAt < 0 || updatedAt < 0) fail('备份会话时间无效。');
  const items = list(raw.messages, '备份消息'); checkBudget(budget, items.length);
  const ids = new Set<string>();
  const messages = items.map((value): Message => {
    const item = row(value, '备份消息'); const messageId = idValue(item.id, '备份消息 ID');
    if (ids.has(messageId)) fail('备份消息 ID 重复。'); ids.add(messageId);
    if (item.role !== 'user' && item.role !== 'assistant') fail('备份消息角色无效。');
    if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt < 0) fail('备份消息时间无效。');
    if (item.contextEligible !== undefined && typeof item.contextEligible !== 'boolean') fail('备份上下文标识无效。');
    const status = messageStatus(item.status, true);
    let attachments: Message['attachments'];
    if (item.attachments !== undefined) {
      if (item.role !== 'user') fail('只有用户消息可以包含附件。');
      try { attachments = parseMessageAttachments(item.attachments); }
      catch { fail('备份附件信息无效，未导入任何会话。'); }
    }
    return {
      id: messageId, role: item.role, content: textValue(item.content, '备份正文'), createdAt: item.createdAt, status,
      ...(item.reasoning === undefined ? {} : { reasoning: textValue(item.reasoning, '备份思考') }),
      ...(item.error === undefined ? {} : { error: textValue(item.error, '备份错误提示') }),
      ...(attachments === undefined ? {} : { attachments }),
      ...(item.contextUsage === undefined ? {} : { contextUsage: backupContextUsage(item.contextUsage) }),
      contextEligible: status !== 'error' && status !== 'refused' && item.contextEligible !== false,
    };
  });
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && !messages[i].contextEligible && messages[i - 1].role === 'user') messages[i - 1].contextEligible = false;
  }
  const importWarnings = raw.importWarnings === undefined ? undefined : list(raw.importWarnings, '导入提醒').map((value) => textValue(value, '导入提醒'));
  return {
    id, title: textValue(raw.title, '备份标题'), createdAt, updatedAt, messages,
    ...(raw.sourceId === undefined ? {} : { sourceId: idValue(raw.sourceId, '来源 ID') }),
    ...(importWarnings ? { importWarnings } : {}),
    ...(raw.originalData === undefined ? {} : { originalData: raw.originalData }),
  };
}

function parseOfficialZip(bytes: Uint8Array, budget: Budget): Conversation[] {
  const files = readZip(bytes);
  const json = (name: string): unknown => {
    const value = files.get(name);
    if (!value) fail(`ZIP 缺少 ${name}。`);
    return parseJson(decodeUtf8(value, name), name);
  };
  const manifest = row(json('manifest.json'), 'manifest');
  if (manifest.export_format_version !== 3) fail('仅支持 DeepSeek ZIP 导出格式 v3，请重新导出聊天记录。');
  const index = list(json('chat_session_index.json'), '会话索引');
  if (index.length > HISTORY_LIMITS.conversations) fail('会话数量超过限制。');
  const ids = new Set<string>(); const conversations: Conversation[] = [];
  for (const value of index) {
    const item = row(value, '会话索引'); const id = idValue(item.id, '索引 ID');
    if (/[/\\]/.test(id) || id === '.' || id === '..' || ids.has(id)) fail('会话索引 ID 重复或无效。');
    ids.add(id);
    const data = row(json(`chat_sessions/${id}.json`), '会话');
    if (data.id !== id) fail('索引与会话文件 ID 不一致。');
    if (!Number.isSafeInteger(item.message_count) || item.message_count !== list(data.messages, '会话消息').length) fail('索引消息数量与会话文件不一致。');
    // originalData stays the exact complete session object, including unknown
    // metadata keys. Never insert importer metadata over a source-owned key.
    conversations.push(importedConversation(data, true, budget));
  }
  for (const name of files.keys()) {
    if (['manifest.json', 'chat_session_index.json', 'user.json'].includes(name)) continue;
    const session = /^chat_sessions\/([^/]+)\.json$/.exec(name);
    if (session && ids.has(session[1])) continue;
    const attachment = /^chat_sessions\/([^/]+)_files\//.exec(name);
    if (attachment && ids.has(attachment[1])) continue;
    fail(`ZIP 中存在未被索引记录的文件：${name}`);
  }
  return conversations;
}

/** Parses into a preview only: never mutates existing conversations. */
export function parseHistory(input: string | Uint8Array, filename: string): ImportPreview {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) fail('文件内容类型不受支持。');
  if (typeof input === 'string' && input.length > HISTORY_LIMITS.inputBytes) fail('文件超过 20 MiB。');
  const bytes = typeof input === 'string' ? strToU8(input) : input;
  if (bytes.length > HISTORY_LIMITS.inputBytes) fail('文件超过 20 MiB。');
  if (!bytes.length) fail('文件为空。');
  const budget: Budget = { messages: 0 }; let conversations: Conversation[]; let sourceLabel: string;
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zip || /\.zip$/i.test(filename)) {
    conversations = parseOfficialZip(bytes, budget); sourceLabel = 'DeepSeek 官方 ZIP v3';
  } else {
    const parsed = parseJson(typeof input === 'string' ? input : decodeUtf8(bytes, filename), filename || '导入文件');
    const object = Array.isArray(parsed) ? undefined : row(parsed, '导入文件');
    const native = object?.schemaVersion !== undefined;
    if (native && object.schemaVersion !== 1) fail('不支持该应用备份版本。');
    if (object?.export_format_version !== undefined && object.export_format_version !== 3) fail('不支持该 DeepSeek 导出版本。');
    const values = Array.isArray(parsed) ? parsed : list(object?.conversations ?? object?.chat_sessions ?? (object?.messages || object?.mapping ? [object] : undefined), '会话列表');
    if (values.length > HISTORY_LIMITS.conversations) fail('会话数量超过限制。');
    conversations = values.map((value) => native ? backupConversation(value, budget) : importedConversation(value, false, budget));
    sourceLabel = native ? '拾语备份 v1' : 'DeepSeek 旧版 JSON';
  }
  const seen = new Set<string>(); const localIds = new Set<string>(); const warnings = new Set<string>();
  for (const conversation of conversations) {
    const key = conversation.sourceId ?? `local:${conversation.id}`;
    if (seen.has(key) || localIds.has(conversation.id)) fail('文件中存在重复的来源会话或本地 ID，未导入任何会话。');
    seen.add(key); localIds.add(conversation.id);
    for (const warning of conversation.importWarnings ?? []) warnings.add(warning);
    if (conversation.messages.some(message => message.attachments?.length)) {
      warnings.add('附件备份只包含 DeepSeek 账户中的文件引用，不含原件；换账户、远端删除或过期后需重新选择原文件。');
    }
  }
  return { conversations, warnings: [...warnings], messageCount: conversations.reduce((sum, item) => sum + item.messages.length, 0), sourceLabel };
}

/** Retains the existing conversation on source-ID or local-ID conflicts. */
export function mergeConversations(existing: Conversation[], incoming: Conversation[]): { conversations: Conversation[]; added: number; skipped: number } {
  const conversations = [...existing];
  const ids = new Set(existing.map((value) => value.id));
  const sources = new Set(existing.flatMap((value) => value.sourceId ? [value.sourceId] : []));
  let added = 0; let skipped = 0;
  for (const conversation of incoming) {
    if (ids.has(conversation.id) || (conversation.sourceId && sources.has(conversation.sourceId))) { skipped++; continue; }
    conversations.push(conversation); ids.add(conversation.id);
    if (conversation.sourceId) sources.add(conversation.sourceId);
    added++;
  }
  return { conversations, added, skipped };
}

/** The app backup includes only app state; API credentials are stored elsewhere. */
export function exportHistory(state: AppState): string {
  const result = JSON.stringify({
    schemaVersion: 1,
    conversations: state.conversations.map(conversation => ({ ...conversation,
      messages: conversation.messages.map(message => ({ ...message,
        ...(message.attachments === undefined ? {} : { attachments: parseMessageAttachments(message.attachments) }),
        ...(message.contextUsage === undefined ? {} : { contextUsage: backupContextUsage(message.contextUsage) }),
      })),
    })),
    activeConversationId: state.activeConversationId,
    settings: {
      model: state.settings.model, thinking: state.settings.thinking,
      contextMessageLimit: state.settings.contextMessageLimit, maxOutputTokens: state.settings.maxOutputTokens,
      ...(state.settings.contextMode === undefined ? {} : { contextMode: state.settings.contextMode }),
    },
  });
  // Refuse to produce a backup this importer cannot subsequently restore.
  parseHistory(result, 'shiyu-backup.json');
  return result;
}
