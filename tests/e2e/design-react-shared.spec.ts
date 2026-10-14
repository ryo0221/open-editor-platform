import { test, expect, create } from './fixtures';
import { value } from './practical-fixtures';
import { artifactMenu } from './template-fixtures';
import { reuseHistory } from './reuse-fixtures';
test('#29 shared ordinary Design uses native authority for React public props and selective Undo', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(90000);
  a.setDefaultTimeout(12000);
  await a.goto('/');
  await create(a, 'design');
  await a.getByRole('button', { name: 'Enable React Web', exact: true }).click();
  await a.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  await artifactMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const url = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL }),
    b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await b.goto(url!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    await b.getByRole('button', { name: 'Layer React Button', exact: true }).click();
    await a.getByRole('button', { name: 'Layer React Button', exact: true }).click();
    for (const editor of [a, b]) {
      if (!(await editor.getByLabel('React prop label', { exact: true }).isVisible()))
        await editor.getByRole('button', { name: 'Toggle Design inspector', exact: true }).click();
    }
    await value(a, 'React prop label', 'Edited by A');
    await expect(b.getByLabel('React prop label', { exact: true })).toHaveValue('Edited by A');
    await value(b, 'Element x', '200');
    await expect(a.getByLabel('Element x', { exact: true })).toHaveValue('200');
    await reuseHistory(a, 'Undo');
    await expect(b.getByLabel('React prop label', { exact: true })).toHaveValue('Continue');
    await expect(b.getByLabel('Element x', { exact: true })).toHaveValue('200');
    await reuseHistory(a, 'Redo');
    await expect(b.getByLabel('React prop label', { exact: true })).toHaveValue('Edited by A');
    await a.screenshot({ path: info.outputPath('shared-design-react.png') });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
