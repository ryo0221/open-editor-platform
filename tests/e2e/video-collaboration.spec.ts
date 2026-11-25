import { expect, test } from './fixtures';

test('independent Video participants edit and save the generated timeline', async ({
  page: a,
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const errors: string[] = [];
  a.on('pageerror', (error) => errors.push(error.message));
  try {
    await a.goto('/?videoCollaboration=new');
    await a.getByRole('button', { name: 'デモを始める' }).click();
    await expect(a.getByRole('status')).toContainText('confirmed r0');
    const b = await context.newPage();
    b.on('pageerror', (error) => errors.push(error.message));
    const invite = await a.getByRole('link', { name: '別の参加者として開く' }).getAttribute('href');
    expect(invite).toBeTruthy();
    await b.goto(invite!);
    await expect(b.getByRole('status')).toContainText('confirmed r0');

    await a.getByLabel('開始位置（秒）').fill('2');
    await b.getByLabel('開始位置（秒）').fill('3');
    await a.getByRole('button', { name: '適用する' }).click();
    await expect(b.getByTestId('clip-range')).toHaveText('2–4 秒');
    await b.getByRole('button', { name: '適用する' }).click();
    await expect(b.getByRole('alert')).toContainText('stale-precondition');
    await expect(b.getByLabel('開始位置（秒）')).toHaveValue('3');
    await b.getByRole('button', { name: '入力を破棄' }).click();

    await b.locator('[data-clip="sample-caption"]').click();
    await b.getByRole('textbox', { name: '字幕', exact: true }).fill('編集した字幕');
    await b.getByRole('button', { name: '適用する' }).click();
    await expect(a.locator('[data-clip="sample-caption"]')).toHaveText('編集した字幕');
    await a.getByRole('button', { name: 'Undo', exact: true }).click();
    await b.locator('[data-clip="sample-picture"]').click();
    await expect(b.getByTestId('clip-range')).toHaveText('1–3 秒');
    await expect(b.locator('[data-clip="sample-caption"]')).toHaveText('編集した字幕');
    await a.getByRole('button', { name: '保存する' }).click();
    await expect(b.getByText('保存した版 r3')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
