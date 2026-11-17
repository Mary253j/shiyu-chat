import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

const DATE = '2026-11-17T12:00:00.000Z';
const QUESTION = '你还记得我养的那只猫吗？';
const ANSWER = '记得，它叫小橘，喜欢晒太阳。';

function officialArchive(id: string, title: string, corruptCrc = false): Uint8Array {
  const session = {
    id, title, inserted_at: DATE, updated_at: DATE, current_message_id: 2,
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: DATE,
        fragments: [{ type: 'REQUEST', content: QUESTION }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: DATE,
        fragments: [{ type: 'RESPONSE', content: ANSWER }] },
    ],
  };
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_session_index.json': strToU8(JSON.stringify([{ id, title, message_count: 2 }])),
    [`chat_sessions/${id}.json`]: strToU8(JSON.stringify(session)),
  });
  if (corruptCrc) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let central = view.getUint32(bytes.length - 6, true);
    // Change both CRC headers for the session, so the failure must come from
    // checking actual file content, not merely comparing the two headers.
    for (let index = 0; index < 2; index++) {
      central += 46 + view.getUint16(central + 28, true) + view.getUint16(central + 30, true)
        + view.getUint16(central + 32, true);
    }
    const local = view.getUint32(central + 42, true);
    const badCrc = (view.getUint32(central + 16, true) ^ 1) >>> 0;
    view.setUint32(central + 16, badCrc, true);
    view.setUint32(local + 14, badCrc, true);
  }
  return bytes;
}

async function navigate(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true })
    .or(page.getByRole('button', { name: label, exact: true })).first().click();
}

async function selectArchive(page: Page, bytes: Uint8Array) {
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入旧对话', exact: true }).click();
  await (await picker).setFiles({ name: 'deepseek-export.zip', mimeType: 'application/zip', buffer: Buffer.from(bytes) });
}

async function confirmPreview(page: Page) {
  await expect(page.getByText('先看看，要带回哪些故事', { exact: true })).toBeVisible();
  await expect(page.getByText('识别到 1 段对话、2 条消息。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认合并导入', exact: true }).click();
  await expect(page.getByText('已导入 1 个对话，保留已有记录，跳过 0 个重复对话。', { exact: true })).toBeVisible();
}

async function expectImportedMessages(page: Page, title: string) {
  await page.getByRole('button', { name: `打开对话 ${title}`, exact: true }).click();
  const messages = page.getByTestId('chat-messages');
  await expect(messages.getByText(QUESTION, { exact: true })).toBeVisible();
  await expect(messages.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid^="chat-message-"]')).toHaveCount(2);
}

test.beforeEach(async ({ page }) => {
  await page.route('https://api.deepseek.com/**', route => route.abort());
  await page.addInitScript(() => {
    // The picker must hand the actual File to the bounded reader. A direct
    // whole-File arrayBuffer call would reproduce the old memory-heavy path;
    // Blob.slice(...).arrayBuffer remains available for small range reads.
    Object.defineProperty(File.prototype, 'arrayBuffer', {
      configurable: true,
      value() { throw new Error('Whole-file arrayBuffer reads are forbidden in this import regression.'); },
    });
  });
});

test('official ZIP can be previewed and merged without reading the entire selected File', async ({ page }) => {
  await page.goto('/library');
  await selectArchive(page, officialArchive('valid-zip', 'ZIP 导入后的旧故事'));
  await confirmPreview(page);
  await expectImportedMessages(page, 'ZIP 导入后的旧故事');
});

test('a ZIP with invalid content CRC is rejected without preview or changing existing conversations', async ({ page }) => {
  await page.goto('/library');
  await selectArchive(page, officialArchive('existing-zip', '已有对话需要保留'));
  await confirmPreview(page);
  await expectImportedMessages(page, '已有对话需要保留');
  await navigate(page, '我的对话');

  await selectArchive(page, officialArchive('broken-zip', '损坏文件不能加入', true));
  await expect(page.getByText(/ZIP 文件校验失败/)).toBeVisible();
  await expect(page.getByText('先看看，要带回哪些故事', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认合并导入', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开对话 损坏文件不能加入', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开对话 已有对话需要保留', exact: true })).toBeVisible();
  await expectImportedMessages(page, '已有对话需要保留');
});
