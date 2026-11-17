import assert from 'node:assert/strict';
import test from 'node:test';
import { ATTACHMENT_LIMITS, classifyAttachment, parseMessageAttachments, type MessageAttachment } from '../src/core/attachments';
import { exportHistory, parseHistory } from '../src/core/history';
import { emptyState, type ContextUsage } from '../src/core/types';

const image: MessageAttachment = { id: 'attachment-1', name: '照片.png', mimeType: 'image/png', bytes: 100,
  kind: 'image', remote: { fileId: 'file-api-test123', purpose: 'user_data', createdAt: 1000 } };
const usage: ContextUsage = { includedHistoryMessages: 10, eligibleHistoryMessages: 12,
  omittedHistoryMessages: 2, truncated: true, reason: '达到上下文预算' };

test('classifies official image, parsed document and user_data formats with canonical MIME', () => {
  assert.deepEqual(classifyAttachment({ name: '中文.PNG', bytes: 1, mimeType: 'application/octet-stream' }),
    { kind: 'image', mimeType: 'image/png', purpose: 'user_data' });
  for (const name of ['report.pdf', 'notes.doc', 'notes.docx', 'slides.ppt', 'slides.pptx']) {
    assert.equal(classifyAttachment({ name, bytes: 100 }).purpose, 'rich_layout_recognition');
  }
  for (const name of ['notes.txt', 'README.md', 'table.csv', 'data.json', 'data.xlsx', 'book.epub', 'code.py']) {
    assert.equal(classifyAttachment({ name, bytes: 100 }).purpose, 'user_data');
  }
  assert.throws(() => classifyAttachment({ name: 'fake.exe', mimeType: 'image/png', bytes: 10 }), /不支持/);
});

test('rejects empty, oversized, invalid names and counts before upload or backup', () => {
  assert.throws(() => classifyAttachment({ name: 'x.png', bytes: 0 }), /为空/);
  assert.throws(() => classifyAttachment({ name: 'x.png', bytes: ATTACHMENT_LIMITS.fileBytes + 1 }), /20 MiB/);
  for (const name of ['../../x.png', 'x\n.png', `${'中'.repeat(171)}.png`]) {
    assert.throws(() => classifyAttachment({ name, bytes: 1 }), /文件名/);
  }
  assert.throws(() => parseMessageAttachments(Array.from({ length: 5 }, (_, i) => ({ ...image, id: `a-${i}` }))), /最多 4/);
  assert.throws(() => parseMessageAttachments([image, image]), /元数据/);
});

test('attachment validation strips device paths, raw data, arbitrary URLs and extra remote fields', () => {
  const dirty = { ...image, localUri: 'file:///private', base64: 'not-for-the-model',
    remote: { ...image.remote, apiKey: 'private-secret', url: 'https://untrusted.invalid/file' } };
  assert.deepEqual(parseMessageAttachments([dirty]), [image]);
  for (const remote of [
    { ...image.remote, fileId: '../../somewhere' },
    { ...image.remote, purpose: 'rich_layout_recognition' },
    { ...image.remote, createdAt: -1 },
    { ...image.remote, expiresAt: 999 },
  ]) assert.throws(() => parseMessageAttachments([{ ...image, remote }]), /引用/);
});

function backupState() {
  return { ...emptyState(), activeConversationId: 'c', conversations: [{
    id: 'c', title: '带附件', createdAt: 1, updatedAt: 2, messages: [
      { id: 'u', role: 'user' as const, content: '', status: 'complete' as const, createdAt: 1, contextEligible: true, attachments: [image] },
      { id: 'a', role: 'assistant' as const, content: '这是一张照片', status: 'complete' as const, createdAt: 2, contextEligible: true, contextUsage: usage },
    ],
  }] };
}

test('backup round-trips remote references and context metadata while preserving legacy schema', () => {
  const state = backupState();
  const backup = exportHistory(state);
  assert.equal(JSON.parse(backup).schemaVersion, 1);
  assert.equal(JSON.parse(backup).settings.contextMode, 'auto');
  const preview = parseHistory(backup, 'backup.json');
  assert.deepEqual(preview.conversations, state.conversations);
  assert.ok(preview.warnings.some(warning => warning.includes('不含原件')));
  const legacy = JSON.parse(backup);
  delete legacy.conversations[0].messages[0].attachments;
  delete legacy.conversations[0].messages[1].contextUsage;
  delete legacy.settings.contextMode;
  assert.equal(parseHistory(JSON.stringify(legacy), 'legacy.json').conversations.length, 1);
});

test('exports sanitize attachment metadata and malformed backups fail without partial imports', () => {
  const state = backupState();
  const dirty = state.conversations[0].messages[0].attachments![0] as MessageAttachment & { localUri?: string };
  dirty.localUri = 'file:///must-not-export';
  (dirty.remote as typeof dirty.remote & { apiKey?: string }).apiKey = 'must-not-export-secret';
  const backup = exportHistory(state);
  assert.ok(!backup.includes('must-not-export'));
  const parsed = JSON.parse(backup);
  parsed.conversations[0].messages[0].attachments[0].remote.fileId = 'https://untrusted.invalid';
  assert.throws(() => parseHistory(JSON.stringify(parsed), 'bad.json'), /备份附件/);
  parsed.conversations[0].messages[0].attachments = [];
  parsed.conversations[0].messages[1].contextUsage.omittedHistoryMessages = 100;
  assert.throws(() => parseHistory(JSON.stringify(parsed), 'bad.json'), /上下文用量/);
});
