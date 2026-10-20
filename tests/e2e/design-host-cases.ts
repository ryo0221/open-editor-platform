import { test, expect } from './fixtures';
import { independentPrototype } from './design-prototype-fixtures';
import { exportDtcg, importDtcg, type TokenSet } from '@editor-platform/reuse-core';

export function designHostCases() {
  test('#289 review: Host replacements update clean mode fields and retain an active edit', async ({
    page,
  }) => {
    await independentPrototype(page, true, { hostContracts: true });
    const field = page.getByRole('textbox', { name: 'モード名（空白で区切る）', exact: true });
    const replace = page.getByRole('button', { name: 'Host replace token draft', exact: true });
    const reset = page.getByRole('button', { name: 'Host reset token modes', exact: true });
    const changes = page.getByLabel('Host token changes', { exact: true });
    const source = page.getByTestId('host-tokens');
    await expect(field).toHaveValue('light dark');
    await replace.click();
    await expect(field).toHaveValue('day night');
    await field.focus();
    await field.press('Tab');
    await expect(changes).toHaveText('0');
    await expect(source).toContainText('"modes":["day","night"]');
    await reset.click();
    await page.getByRole('combobox', { name: '編集する値', exact: true }).selectOption('dark');
    await field.focus();
    // A Host update can arrive without moving focus or blurring the input.
    await replace.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('day night');
    await expect(page.getByRole('combobox', { name: '編集する値', exact: true })).toHaveValue('');
    await field.press('Tab');
    await expect(changes).toHaveText('0');
    await reset.click();
    await field.fill('day night custom');
    await replace.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('day night custom');
    await expect(source).toContainText('"modes":["day","night"]');
    await field.press('Tab');
    await expect(changes).toHaveText('1');
    const tokens: TokenSet = JSON.parse((await source.textContent())!);
    expect(tokens.modes).toEqual(['day', 'night', 'custom']);
    expect(tokens.defaultMode).toBe('day');
    expect(tokens.tokens['brand.color'].description).toBe('Host replacement');
    await reset.click();
    await expect(field).toHaveValue('light dark');
  });

  test('#289 review: internal token actions do not submit a surrounding Host form', async ({
    page,
  }, info) => {
    await independentPrototype(page, true, { hostContracts: true });
    await page.getByRole('textbox', { name: 'トークンID', exact: true }).fill('extra.color');
    await page.getByRole('button', { name: 'トークンを追加', exact: true }).click();
    await expect(page.getByTestId('host-tokens')).toContainText('"extra.color"');
    await expect(page.getByLabel('Host token changes', { exact: true })).toHaveText('1');
    await expect(page.getByLabel('Host token submissions', { exact: true })).toHaveText('0');
    await page.getByRole('button', { name: '「extra.color」を削除', exact: true }).click();
    await expect(page.getByTestId('host-tokens')).not.toContainText('"extra.color"');
    await expect(page.getByLabel('Host token changes', { exact: true })).toHaveText('2');
    await expect(page.getByLabel('Host token submissions', { exact: true })).toHaveText('0');
    await page.getByRole('button', { name: 'Host publish tokens', exact: true }).click();
    await expect(page.getByLabel('Host token submissions', { exact: true })).toHaveText('1');
    await page.screenshot({ path: info.outputPath('host-token-form-actions.png') });
  });

  test('#288 opening and reverting prototype settings preserves legacy native content', async ({
    page,
  }) => {
    await independentPrototype(page, true, { hostContracts: true, legacy: true });
    const source = page.getByTestId('prototype-source');
    const original = await source.textContent();
    expect(JSON.parse(original!)).not.toHaveProperty('prototyping');
    await page.getByRole('button', { name: 'Host save', exact: true }).click();
    await expect(page.getByLabel('Host content hash')).toHaveText(/^[a-f0-9]{64}$/);
    const hash = await page.getByLabel('Host content hash').textContent();
    const start = page.getByLabel('Saved prototype start frame', { exact: true });
    if (!(await start.isVisible()))
      await page.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
    await start.selectOption('Review');
    await expect(source).not.toHaveText(original!);
    await start.selectOption('');
    await expect(source).toHaveText(original!);
    await page.getByRole('button', { name: 'Host undo', exact: true }).click();
    await expect(start).toHaveValue('Review');
    await page.getByRole('button', { name: 'Host redo', exact: true }).click();
    await expect(source).toHaveText(original!);
    await page.getByRole('button', { name: 'Add prototype flow', exact: true }).click();
    await expect(source).toContainText('"flows":[{');
    await page.getByRole('button', { name: 'Delete prototype flow', exact: true }).click();
    await expect(source).toHaveText(original!);
    await page.getByRole('button', { name: 'Host save', exact: true }).click();
    await expect(page.getByLabel('Host content hash')).toHaveText(hash!);
    await page.reload();
    await expect(source).toHaveText(original!);
  });

  test('#289 a Host imports the public TokenSetForm and edits base and mode values', async ({
    page,
  }, info) => {
    await independentPrototype(page, true, { hostContracts: true });
    await page.getByLabel('brand.colorの色', { exact: true }).fill('#336699');
    await page.getByRole('combobox', { name: '編集する値', exact: true }).selectOption('dark');
    await page.getByLabel('brand.colorをdarkで上書き', { exact: true }).check();
    await page.getByLabel('brand.colorの色', { exact: true }).fill('#ffffff');
    await page.screenshot({ path: info.outputPath('public-token-form.png') });
    const tokens: TokenSet = JSON.parse((await page.getByTestId('host-tokens').textContent())!);
    expect(tokens.tokens['brand.color'].value).toEqual({
      colorSpace: 'srgb',
      components: [0.2, 0.4, 0.6],
      alpha: 1,
    });
    expect(tokens.tokens['brand.color'].modes?.dark).toEqual({
      colorSpace: 'srgb',
      components: [1, 1, 1],
      alpha: 1,
    });
    const exported = exportDtcg(tokens, 'dark');
    expect(exported.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    expect(importDtcg(exported.document).tokens?.tokens['brand.color'].value).toEqual(
      tokens.tokens['brand.color'].modes?.dark,
    );
  });
}
