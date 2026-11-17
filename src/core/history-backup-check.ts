import { exportHistory, HISTORY_LIMITS } from './history';
import { checkHistoryInputSize } from './history-limits';
import type { AppState } from './types';

export interface BackupCheckProgress { completed: number; total: number }
export interface BackupCheckOptions {
  yieldControl?: () => Promise<void>;
  onProgress?: (progress: BackupCheckProgress) => void;
}
export interface BackupCheckResult {
  bytes: number;
  jsonNodes: number;
  messageCount: number;
  conversationCount: number;
}

/**
 * Counts an already validated JSON string without making a UTF-8 buffer or
 * another parsed object. Keys are not nodes, matching history's JSON budget.
 */
function measureJson(json: string): { bytes: number; nodes: number } {
  let bytes = 0; let nodes = 0; let quoted = false; let escaped = false; let valueExpected = true;
  const containers: boolean[] = [];
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < json.length
      && json.charCodeAt(index + 1) >= 0xdc00 && json.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index++;
    } else bytes += 3;

    if (quoted) {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === 34) quoted = false;
      continue;
    }
    if (code === 34) {
      if (valueExpected) nodes++;
      valueExpected = false; quoted = true;
    } else if (code === 123 || code === 91) {
      nodes++; containers.push(code === 91); valueExpected = code === 91;
    } else if (code === 125 || code === 93) {
      containers.pop(); valueExpected = false;
    } else if (code === 58) valueExpected = true;
    else if (code === 44) valueExpected = containers[containers.length - 1] === true;
    else if (valueExpected && code !== 32 && code !== 10 && code !== 13 && code !== 9) {
      nodes++; valueExpected = false;
    }
  }
  return { bytes, nodes };
}

function normalizedId(value: unknown): string {
  if (typeof value === 'string' && value.trim() && value.length <= 500) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('无法导入：备份会话 ID 缺失或无效。');
}

/**
 * Check a proposed merge without serializing and reparsing the entire library.
 * Each conversation goes through the existing export/restore validation, then
 * its temporary serialized data can be released before checking the next one.
 * Aggregate limits are exact for the final export, not estimates. The caller's
 * state and conversations are never mutated, so a failed check cannot import
 * partial data. A single large conversation still needs working memory.
 */
export async function assertHistoryBackupable(state: AppState, options: BackupCheckOptions = {}): Promise<BackupCheckResult> {
  const count = state.conversations.length;
  if (count > HISTORY_LIMITS.conversations) throw new Error('无法导入：会话数量超过限制。');
  options.onProgress?.({ completed: 0, total: count });
  await options.yieldControl?.();
  const envelope = measureJson(exportHistory({ ...state, conversations: [] }));
  let bytes = envelope.bytes; let jsonNodes = envelope.nodes; let messageCount = 0;
  const localIds = new Set<string>(); const sourceKeys = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (index) await options.yieldControl?.();
    const conversation = state.conversations[index];
    // exportHistory validates optional fields before serialization, including
    // deletion boundaries/revisions, then verifies the restored conversation.
    const measured = measureJson(exportHistory({ ...state, conversations: [conversation] }));
    const id = normalizedId(conversation.id);
    const key = conversation.sourceId === undefined ? `local:${id}` : normalizedId(conversation.sourceId);
    if (localIds.has(id) || sourceKeys.has(key)) throw new Error('无法导入：文件中存在重复的来源会话或本地 ID，未导入任何会话。');
    localIds.add(id); sourceKeys.add(key);
    messageCount += conversation.messages.length;
    if (messageCount > HISTORY_LIMITS.messages) throw new Error(`无法导入：消息总数超过 ${HISTORY_LIMITS.messages} 条。`);
    bytes += measured.bytes - envelope.bytes + (index ? 1 : 0);
    jsonNodes += measured.nodes - envelope.nodes;
    checkHistoryInputSize(bytes);
    if (jsonNodes > HISTORY_LIMITS.jsonNodes) throw new Error('无法导入：备份包含过多数据节点。');
    options.onProgress?.({ completed: index + 1, total: count });
  }
  return { bytes, jsonNodes, messageCount, conversationCount: count };
}
