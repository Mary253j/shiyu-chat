import { expect, test, type Page } from '@playwright/test';

const API = 'https://api.deepseek.com';
const CONVERSATION_ID = 'message-deletion-fixture';
const TITLE = '消息删除回归';
const MESSAGES = [
  { id: 'delete-u1', role: 'user', content: '待删除问题：DELETE_USER_TOKEN。', createdAt: 1, status: 'complete' },
  { id: 'keep-a1', role: 'assistant', content: '保留第一条回复。', createdAt: 2, status: 'complete' },
  { id: 'keep-u2', role: 'user', content: '保留第二个问题。', createdAt: 3, status: 'complete' },
  { id: 'delete-a2', role: 'assistant', content: '待删除回复：DELETE_ASSISTANT_TOKEN。', createdAt: 4, status: 'complete' },
  { id: 'keep-u3', role: 'user', content: '保留完整一轮的问题：KEEP_CONTEXT_TOKEN。', createdAt: 5, status: 'complete' },
  { id: 'keep-a3', role: 'assistant', content: '保留完整一轮的回复。', createdAt: 6, status: 'complete' },
];

async function navigate(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true })
    .or(page.getByRole('button', { name: label, exact: true })).first().click();
}

async function connect(page: Page) {
  await page.route(`${API}/user/balance`, route => route.fulfill({ json: {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.34' }],
  } }));
  await navigate(page, '连接与设置');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-fake-api-key');
  await page.getByRole('button', { name: '验证并安全保存', exact: true }).click();
  await expect(page.getByText('连接成功，可以开始聊天了。', { exact: true })).toBeVisible();
}

async function openConversation(page: Page) {
  await navigate(page, '我的对话');
  await page.getByRole('button', { name: `打开对话 ${TITLE}`, exact: true }).click();
  await expect(page.getByTestId('chat-messages')).toBeVisible();
}

async function importConversation(page: Page, messages = MESSAGES) {
  const fixture = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    conversations: [{
      id: CONVERSATION_ID, title: TITLE, createdAt: 1, updatedAt: messages.at(-1)?.createdAt ?? 1, messages,
      // A deleted message must not survive inside a preserved import payload.
      originalData: { id: 'synthetic-original-conversation', messages },
    }],
  }));
  await navigate(page, '我的对话');
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入旧对话', exact: true }).click();
  await (await picker).setFiles({ name: 'message-deletion.json', mimeType: 'application/json', buffer: fixture });
  await expect(page.getByText('先看看，要带回哪些故事', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认合并导入', exact: true }).click();
  await expect(page.getByText('已导入 1 个对话，保留已有记录，跳过 0 个重复对话。', { exact: true })).toBeVisible();
  await openConversation(page);
}

function messageRow(page: Page, id: string) {
  return page.getByTestId(`chat-message-${id}`);
}

async function expectMessages(page: Page, deletedIds: string[] = []) {
  for (const message of MESSAGES) {
    const row = messageRow(page, message.id);
    if (deletedIds.includes(message.id)) await expect(row).toHaveCount(0);
    else await expect(row).toContainText(message.content);
  }
}

async function exportBackup(page: Page) {
  await navigate(page, '我的对话');
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test.beforeEach(async ({ page }) => {
  // Only explicit mock routes below may answer; no real paid API requests.
  await page.route(`${API}/**`, route => route.abort());
});

test('single-message deletion can be cancelled and keeps only the confirmed deletion when reopening', async ({ page }) => {
  await page.goto('/');
  await importConversation(page);
  await expectMessages(page);
  const target = messageRow(page, 'delete-a2');
  await target.getByRole('button', { name: '删除此消息', exact: true }).click();
  await expect(page.getByText('删除 1 条消息？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认删除消息', exact: true })).toHaveCount(0);
  await expectMessages(page);

  await target.getByRole('button', { name: '删除此消息', exact: true }).click();
  await page.getByRole('button', { name: '确认删除消息', exact: true }).click();
  await expectMessages(page, ['delete-a2']);
  // Web storage is page memory; native persistence is covered separately.
  // Switching tabs and reopening must retain the unselected question in this turn.
  await navigate(page, '连接与设置');
  await openConversation(page);
  await expectMessages(page, ['delete-a2']);
});

test('batch deletion preserves unselected messages and removes deleted text from backups and chat context', async ({ page }) => {
  test.setTimeout(45000);
  let requestBody: Record<string, unknown> | undefined;
  await page.route(`${API}/chat/completions`, async route => {
    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    const frames = [
      { choices: [{ delta: { content: '删除后仍然可以续聊。' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    });
  });
  await page.goto('/');
  await connect(page);
  await importConversation(page);
  await expectMessages(page);

  await page.getByRole('button', { name: '选择消息', exact: true }).click();
  await expect(page.getByText('已选 0 条', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '删除选中消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '全选消息', exact: true }).click();
  await expect(page.getByText('已选 6 条', { exact: true })).toBeVisible();
  for (const message of MESSAGES) {
    await expect(messageRow(page, message.id).getByRole('checkbox', { name: '选择此消息', exact: true })).toBeChecked();
  }
  await page.getByRole('button', { name: '取消全选', exact: true }).click();
  await expect(page.getByText('已选 0 条', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全选消息', exact: true }).click();
  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择此消息', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认删除消息', exact: true })).toHaveCount(0);
  await expectMessages(page);

  await page.getByRole('button', { name: '选择消息', exact: true }).click();
  const deletedIds = ['delete-u1', 'delete-a2'];
  for (const id of deletedIds) {
    const checkbox = messageRow(page, id).getByRole('checkbox', { name: '选择此消息', exact: true });
    await checkbox.click();
    await expect(checkbox).toBeChecked();
  }
  await expect(page.getByText('已选 2 条', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除选中消息', exact: true }).click();
  await expect(page.getByText('删除 2 条消息？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认删除消息', exact: true }).click();
  await expectMessages(page, deletedIds);

  const exported = await exportBackup(page);
  expect(exported).not.toContain('DELETE_USER_TOKEN');
  expect(exported).not.toContain('DELETE_ASSISTANT_TOKEN');
  const backup = JSON.parse(exported) as { conversations: { id: string; messages: { id: string }[] }[] };
  expect(backup.conversations.find(conversation => conversation.id === CONVERSATION_ID)?.messages.map(message => message.id))
    .toEqual(MESSAGES.filter(message => !deletedIds.includes(message.id)).map(message => message.id));

  await openConversation(page);
  await page.getByLabel('输入消息', { exact: true }).fill('请接着聊。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('删除后仍然可以续聊。', { exact: true })).toBeVisible();
  expect(requestBody).toBeDefined();
  expect(JSON.stringify(requestBody)).not.toContain('DELETE_USER_TOKEN');
  expect(JSON.stringify(requestBody)).not.toContain('DELETE_ASSISTANT_TOKEN');
  expect(JSON.stringify(requestBody?.messages)).toContain('KEEP_CONTEXT_TOKEN');
});

test('deleting the failed reply prompt does not offer retry with an unrelated surviving user message', async ({ page }) => {
  const messages = [
    { id: 'older-unrelated-user', role: 'user', content: '这是更早的另一个问题。', createdAt: 1, status: 'complete' },
    { id: 'failed-reply-prompt', role: 'user', content: '这是生成失败对应的问题。', createdAt: 2, status: 'complete' },
    { id: 'failed-reply', role: 'assistant', content: '', createdAt: 3, status: 'error' },
  ];
  await page.goto('/');
  await importConversation(page, messages);
  const retry = page.getByRole('button', { name: '重新生成（将消耗 API）', exact: true });
  await expect(retry).toBeVisible();
  await messageRow(page, 'failed-reply-prompt').getByRole('button', { name: '删除此消息', exact: true }).click();
  await expect(page.getByText('删除 1 条消息？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认删除消息', exact: true }).click();
  await expect(messageRow(page, 'failed-reply-prompt')).toHaveCount(0);
  await expect(messageRow(page, 'older-unrelated-user')).toContainText(messages[0].content);
  await expect(messageRow(page, 'failed-reply')).toBeVisible();
  await expect(retry).toHaveCount(0);

  await openConversation(page);
  await expect(messageRow(page, 'older-unrelated-user')).toContainText(messages[0].content);
  await expect(messageRow(page, 'failed-reply')).toBeVisible();
  await expect(retry).toHaveCount(0);
});
