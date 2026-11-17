import { test, expect, Page } from '@playwright/test';

async function navigate(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true })
    .or(page.getByRole('button', { name: label, exact: true })).first().click();
}
async function connect(page: Page) {
  await page.route('https://api.deepseek.com/user/balance', route => route.fulfill({ json: {
    is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
  } }));
  await navigate(page, '连接与设置');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-fake-api-key');
  await page.getByRole('button', { name: '验证并安全保存', exact: true }).click();
  await expect(page.getByText('连接成功，可以开始聊天了。', { exact: true })).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  // No test may make a real paid API request.
  await page.route('https://api.deepseek.com/**', route => route.abort());
});

test('free client has working navigation and no donation paywall', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('把故事，接着聊。', { exact: true }).last()).toBeVisible();
  await navigate(page, '连接与设置');
  await expect(page.getByText('所有功能免费，没有广告，也没有会员。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '🍗 请作者吃个鸡腿 →' }).click();
  await expect(page.getByText('所有功能免费 · 打赏完全自愿', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择微信收款', exact: true })).toBeVisible();
  await expect(page.getByText('打赏暂未开放，感谢你的心意。')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('support shows original payment images, switches methods and closes the large image', async ({ page }) => {
  await page.goto('/support');
  await expect(page.getByText('所有功能免费 · 打赏完全自愿', { exact: true })).toBeVisible();
  await expect(page.getByText('打赏只是支持开发维护，不会解锁功能，也不包含 DeepSeek API 费用。不打赏，也一样好好聊天。')).toBeVisible();

  const wechat = page.getByTestId('support-code-wechat');
  await expect(wechat).toBeVisible();
  await expect.poll(() => wechat.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1300 && image.naturalHeight === 1769)).toBe(true);
  const wechatBox = await wechat.boundingBox();
  expect(wechatBox).not.toBeNull();
  expect(wechatBox!.width / wechatBox!.height).toBeCloseTo(1300 / 1769, 2);
  await expect(page.getByText('收款人：Wenstel(**星)', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '选择支付宝收款', exact: true }).click();
  await expect(wechat).toHaveCount(0);
  const alipay = page.getByTestId('support-code-alipay');
  await expect(alipay).toBeVisible();
  await expect.poll(() => alipay.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1260 && image.naturalHeight === 1890)).toBe(true);
  const alipayBox = await alipay.boundingBox();
  expect(alipayBox!.width / alipayBox!.height).toBeCloseTo(1260 / 1890, 2);
  await expect(page.getByText('收款人：**星', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '查看支付宝收款码大图', exact: true }).click();
  const original = page.getByTestId('support-code-original-alipay');
  await expect(original).toBeVisible();
  const originalBox = await original.boundingBox();
  expect(originalBox!.width).toBeGreaterThan(alipayBox!.width);
  expect(originalBox!.width / originalBox!.height).toBeCloseTo(1260 / 1890, 2);
  await page.getByRole('button', { name: '关闭收款码大图', exact: true }).click();
  await expect(original).toHaveCount(0);
  await expect(page.getByText(/截图保存收款码，然后打开支付宝的“扫一扫”/)).toBeVisible();

  await page.getByRole('button', { name: '选择微信收款', exact: true }).click();
  await expect(wechat).toBeVisible();
  await navigate(page, '聊一会儿');
  await expect(page.getByLabel('输入消息', { exact: true })).toBeVisible();
});

test('connect, streamed reply, rename, export and import without exposing key', async ({ page }) => {
  await page.goto('/');
  await connect(page);
  let requestBody: Record<string, unknown> | undefined;
  await page.route('https://api.deepseek.com/chat/completions', async route => {
    requestBody = route.request().postDataJSON();
    const frames = [
      { choices: [{ delta: { reasoning_content: '先认真听完。' }, finish_reason: null }] },
      { choices: [{ delta: { content: '今天的阳光真好。我们可以慢慢聊。' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 } },
    ];
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n' });
  });
  await navigate(page, '聊一会儿');
  await page.getByLabel('输入消息', { exact: true }).fill('今天想散散步');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('今天的阳光真好。我们可以慢慢聊。', { exact: true })).toBeVisible();
  expect(requestBody?.safety_check).toEqual({ level: 'high' });
  expect(requestBody?.messages).toEqual([{ role: 'user', content: '今天想散散步' }]);
  await navigate(page, '我的对话');
  await page.getByRole('button', { name: '重命名 今天想散散步' }).click();
  await page.getByLabel('对话名称').fill('散步日记');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.getByText('散步日记', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  expect(text).not.toContain('test-only-fake-api-key');
  expect(text).toContain('散步日记');
  const pickerPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入旧对话', exact: true }).click();
  await (await pickerPromise).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByText('先看看，要带回哪些故事')).toBeVisible();
  await page.getByRole('button', { name: '确认合并导入', exact: true }).click();
  await expect(page.getByText('已导入 0 个对话，保留已有记录，跳过 1 个重复对话。')).toBeVisible();
  await page.getByRole('button', { name: '删除 散步日记' }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText('散步日记', { exact: true }).last()).toBeVisible();
});

test('invalid import leaves existing data, and refusal removes generated content', async ({ page }) => {
  await page.goto('/'); await connect(page);
  await page.route('https://api.deepseek.com/chat/completions', route => route.fulfill({ contentType: 'text/event-stream', body:
    'data: {"choices":[{"delta":{"content":"这段内容应被清除"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n' }));
  await navigate(page, '聊一会儿');
  await page.getByLabel('输入消息').fill('测试安全处理');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('这次内容未通过服务方安全检查。可以换个话题继续聊。')).toBeVisible();
  await expect(page.getByText('这段内容应被清除')).toHaveCount(0);
  await navigate(page, '我的对话');
  const pickerPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入旧对话', exact: true }).click();
  await (await pickerPromise).setFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await expect(page.getByText(/JSON 已损坏/)).toBeVisible();
  await expect(page.getByText('测试安全处理', { exact: true }).last()).toBeVisible();
});
