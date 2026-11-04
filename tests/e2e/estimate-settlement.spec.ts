import { test, expect } from './fixtures';
test.beforeEach(async ({ page }) => {
  await page.goto('/estimate-settlement-test.html');
});
test('Surface-owned waiter survives rerenders and labels; separate Surface stays idle', async ({
  page,
}, info) => {
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  const b = page.getByRole('region', { name: 'Host B', exact: true });
  await a.getByRole('button', { name: '計算して採用', exact: true }).click();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Save notice')).toHaveText('waiting');
  await a.getByRole('button', { name: '計算を取消', exact: true }).evaluate((button) => {
    button.textContent = 'Different label';
  });
  await a.getByRole('button', { name: 'Rerender', exact: true }).click();
  await b.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(b.getByLabel('Saved calculations')).toHaveText('0');
  await expect(a.getByLabel('Saved calculations')).toBeEmpty();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByLabel('Saved calculations')).toHaveText('1');
  await expect(a.getByLabel('Save notice')).toHaveText('saved');
  await page.screenshot({ path: info.outputPath('settlement.png'), fullPage: true });
});
test('trial remains a candidate until explicit adoption', async ({ page }) => {
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  await a.getByRole('button', { name: '試算して比較', exact: true }).click();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByLabel('Save notice')).toHaveText('candidate');
  await expect(a.getByLabel('Saved calculations')).toBeEmpty();
  await a.getByRole('button', { name: '見積差分を採用', exact: true }).click();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Saved calculations')).toHaveText('1');
});
for (const action of ['Replace', 'Detach', '計算を取消']) {
  test(`${action} releases the old instance waiter and ignores late response`, async ({ page }) => {
    const a = page.getByRole('region', { name: 'Host A', exact: true });
    await a.getByRole('button', { name: '計算して採用', exact: true }).click();
    await a.getByRole('button', { name: 'Host save', exact: true }).click();
    await a.getByRole('button', { name: action, exact: true }).click();
    await expect(a.getByLabel('Save notice')).toHaveText(
      action === '計算を取消' ? 'cancelled' : 'closed',
    );
    await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
    await expect(a.getByLabel('Saved calculations')).toBeEmpty();
  });
}

test('Host input preparation rejects save and preserves an uncommitted form through rerender', async ({
  page,
}) => {
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  await a.getByRole('button', { name: '数量を追加', exact: true }).click();
  await a.getByLabel('名称', { exact: true }).fill('Keep my input');
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Save notice')).toContainText('確定');
  await a.getByRole('button', { name: 'Rerender', exact: true }).click();
  await expect(a.getByLabel('名称', { exact: true })).toHaveValue('Keep my input');
  await expect(a.getByLabel('Saved calculations')).toBeEmpty();
  await a.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(a.getByLabel('名称', { exact: true })).toHaveCount(0);
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Saved calculations')).toHaveText('0');
});
test('a key remount discards the old preview without adopting it in the new session', async ({
  page,
}) => {
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  await a.getByRole('button', { name: '試算して比較', exact: true }).click();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByRole('region', { name: '見積提案差分' })).toBeVisible();
  await a.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(a.getByRole('region', { name: '見積提案差分' })).toHaveCount(0);
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Saved calculations')).toHaveText('0');
});
test('retired cleanup and late worker delivery cannot unregister or save the replacement', async ({
  page,
}) => {
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  await a.getByRole('button', { name: '計算して採用', exact: true }).click();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await a.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(a.getByLabel('Save notice')).toHaveText('closed');
  await a.getByRole('button', { name: 'Replay retired cleanup', exact: true }).click();
  await a.getByRole('button', { name: '計算して採用', exact: true }).click();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByLabel('Save notice')).toHaveText('waiting');
  await expect(a.getByLabel('Saved calculations')).toBeEmpty();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByLabel('Saved calculations')).toHaveText('1');
});
test('deadline fails only that save; late adoption needs a separate explicit save', async ({
  page,
}) => {
  await page.clock.install();
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  await a.getByLabel('Wait deadline ms').fill('1000');
  await a.getByRole('button', { name: '計算して採用', exact: true }).click();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Save notice')).toHaveText('waiting');
  await page.clock.fastForward(1001);
  await expect(a.getByLabel('Save notice')).toHaveText('timeout');
  await expect(a.getByRole('button', { name: '計算を取消', exact: true })).toBeEnabled();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByRole('region', { name: '見積結果', exact: true })).toContainText('1,350');
  await expect(a.getByLabel('Saved calculations')).toBeEmpty();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Saved calculations')).toHaveText('1');
});
for (const action of ['Fail worker', '計算を取消']) {
  test(`${action} rejects repeated Host and Surface saves without a false success notice`, async ({
    page,
  }) => {
    const a = page.getByRole('region', { name: 'Host A', exact: true });
    await a.getByRole('button', { name: '計算して採用', exact: true }).click();
    await a.getByRole('button', { name: 'Host save', exact: true }).click();
    await a.getByRole('button', { name: action, exact: true }).click();
    const status = action === 'Fail worker' ? 'failed' : 'cancelled';
    await expect(a.getByLabel('Save notice')).toHaveText(status);
    await a.getByRole('button', { name: '保存', exact: true }).click();
    await expect(a.locator('[role=alert]')).toContainText(status);
    await expect(a.getByLabel('Saved calculations')).toBeEmpty();
    await expect(a.getByRole('status', { name: '見積の状態' })).not.toContainText('保存しました');
  });
}

test('rejecting the old preview during a new calculation keeps the save waiting for that calculation', async ({
  page,
}) => {
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  await a.getByRole('button', { name: '試算して比較', exact: true }).click();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByRole('region', { name: '見積提案差分' })).toBeVisible();
  await a.getByRole('button', { name: '計算して採用', exact: true }).click();
  await a.getByRole('button', { name: 'Host save', exact: true }).click();
  await expect(a.getByLabel('Save notice')).toHaveText('waiting');
  await a.getByRole('button', { name: '見積差分を採用', exact: true }).click();
  await expect(a.locator('[role=alert]')).toContainText('stale-result');
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await expect(a.getByRole('region', { name: '見積結果', exact: true })).toContainText('1,350');
  await expect(a.getByLabel('Save notice')).toHaveText('saved');
  await expect(a.getByLabel('Saved calculations')).toHaveText('1');
});

for (const failure of ['Reject persistence', 'Expire persistence']) {
  test(`${failure} clears a previous Surface save notice before awaiting and after rejection`, async ({
    page,
  }, info) => {
    const a = page.getByRole('region', { name: 'Host A', exact: true });
    const save = a.getByRole('button', { name: '保存', exact: true });
    const notice = a.getByRole('status', { name: '見積の状態' });
    await save.click();
    await expect(notice).toHaveText('保存しました。');
    await a.getByLabel('Hold persistence').check();
    await save.click();
    await expect(a.getByLabel('Save notice')).toHaveText('waiting');
    await expect(notice).not.toContainText('保存しました');
    await a.getByRole('button', { name: failure, exact: true }).click();
    await expect(a.locator('[role=alert]')).toHaveText(
      failure === 'Reject persistence' ? 'PUT 500' : 'timeout',
    );
    await expect(notice).not.toContainText('保存しました');
    await page.screenshot({ path: info.outputPath('save-rejected.png'), fullPage: true });
    await save.click();
    await a.getByRole('button', { name: 'Resolve persistence', exact: true }).click();
    await expect(notice).toHaveText('保存しました。');
    await expect(a.locator('[role=alert]')).toHaveCount(0);
  });
}
test('confirmed edit and candidate rejection do not retain a previous save success', async ({
  page,
}) => {
  const a = page.getByRole('region', { name: 'Host A', exact: true });
  const save = a.getByRole('button', { name: '保存', exact: true });
  const notice = a.getByRole('status', { name: '見積の状態' });
  await save.click();
  await expect(notice).toHaveText('保存しました。');
  await a.getByRole('button', { name: '数量を編集', exact: true }).first().click();
  await a.getByLabel('名称', { exact: true }).fill('Unsaved edit');
  await a.getByRole('button', { name: '項目を確定', exact: true }).click();
  await expect(a.getByRole('region', { name: '項目の編集', exact: true })).toHaveCount(0);
  await expect(notice).not.toContainText('保存しました');
  await a.getByLabel('Hold persistence').check();
  await save.click();
  await a.getByRole('button', { name: 'Reject persistence', exact: true }).click();
  await expect(a.locator('[role=alert]')).toHaveText('PUT 500');
  await expect(a.getByText('Unsaved edit', { exact: true })).toBeVisible();
  await expect(notice).not.toContainText('保存しました');
  await a.getByLabel('Hold persistence').uncheck();
  await save.click();
  await expect(notice).toHaveText('保存しました。');
  await a.getByRole('button', { name: '試算して比較', exact: true }).click();
  await a.getByRole('button', { name: 'Deliver worker', exact: true }).click();
  await save.click();
  await expect(a.locator('[role=alert]')).toHaveText('candidate');
  await expect(notice).not.toContainText('保存しました');
});
