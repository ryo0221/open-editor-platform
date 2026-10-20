import { test, expect } from './fixtures';
import { unzipSync, strFromU8 } from 'fflate';
import { readFile } from 'node:fs/promises';
import { nativeArtifact, save } from './fixtures';
import { parseReactScreenProposal } from '@editor-platform/react-ui-core';
import type { Page } from '@playwright/test';

async function applyBindings(page: Page) {
  const button = page.getByRole('button', { name: 'Apply bindings', exact: true });
  // Headless Firefox can miss native input at a nested scroll region's lower
  // edge. Use an ordinary scroll and native click, retaining the same action
  // and assertions without dispatching events or forcing the click.
  await button.evaluate((element) =>
    element.scrollIntoView({ block: 'center', inline: 'nearest' }),
  );
  await button.click();
}
test('W2 original React preview, props edit and deterministic TSX bundle', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New React UI', exact: true }).click();
  const frame = page.frameLocator('iframe[title="React component preview"]');
  await expect(frame.getByText('Color study', { exact: true })).toBeVisible();
  await expect(frame.getByRole('region', { name: 'Reference card' })).toHaveAttribute(
    'data-theme',
    'light',
  );
  await frame.getByRole('region', { name: 'Reference card' }).evaluate((element) => {
    element.setAttribute('data-retained-preview', 'same-dom');
  });
  await page.getByRole('button', { name: 'title · Text', exact: true }).click();
  await page.getByLabel('Prop text', { exact: true }).fill('A <literal> {value} & "quote"');
  await expect(frame.getByText('A <literal> {value} & "quote"', { exact: true })).toBeVisible();
  await expect(frame.getByRole('region', { name: 'Reference card' })).toHaveAttribute(
    'data-retained-preview',
    'same-dom',
  );
  await page.getByRole('button', { name: 'Move up', exact: true }).click();
  const body = frame.getByRole('region', { name: 'Reference card' });
  await expect(body.locator('p').first()).toHaveText('A <literal> {value} & "quote"');
  await page.getByLabel('Preview width', { exact: true }).selectOption('1024');
  await expect(frame.getByRole('region', { name: 'Reference card' })).toHaveCSS('display', 'grid');
  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await frame.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Callback onPress' })).toHaveCount(0);
  await page.getByText('Page data, callbacks & breakpoints', { exact: true }).click();
  const contract = JSON.parse(
    await page.getByLabel('Page contract JSON', { exact: true }).inputValue(),
  );
  contract.callbacks.onBuy = { parameters: [], returns: 'void' };
  await page.getByLabel('Page contract JSON', { exact: true }).fill(JSON.stringify(contract));
  await page.getByRole('button', { name: 'Apply page contract', exact: true }).click();
  await page.getByText('Page data, callbacks & breakpoints', { exact: true }).click();
  await page.getByRole('button', { name: 'buy · Button', exact: true }).click();
  await page
    .getByLabel('Callback binding onPress', { exact: true })
    .selectOption({ label: 'onBuy' });
  await applyBindings(page);
  await frame.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Callback onPress' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export React TSX', exact: true }).click();
  const download = await downloadPromise;
  const files = unzipSync(await readFile((await download.path())!));
  const tsx = strFromU8(files['Screen.tsx']);
  expect(tsx).toContain('from "@reference/ui"');
  expect(tsx).toContain('\\u003cliteral\\u003e');
  expect(tsx).not.toMatch(/editor-platform|data-react-ui-node|sandbox|history|collaboration/);
  expect(
    JSON.parse(strFromU8(files['composition.json'])).nodes.find(
      (n: { id: string }) => n.id === 'title',
    ).props.text,
  ).toBe('A <literal> {value} & "quote"');
  await page.screenshot({ path: info.outputPath('react-ui-w2-desktop.png') });
});
test('W2 exported TSX builds and renders in an independent React app', async ({ page }) => {
  await page.goto('http://127.0.0.1:4175');
  await expect(page.getByRole('region', { name: 'Reference card' })).toHaveAttribute(
    'data-theme',
    'light',
  );
  await expect(page.getByText('Color study', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Color study', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  expect(await page.locator('iframe').count()).toBe(0);
});
test('W3 typed bindings, controlled input, callbacks, save/reload and native round trip', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New React UI', exact: true }).click();
  await page.getByRole('button', { name: 'Load example Contact form', exact: true }).click();
  const frame = page.frameLocator('iframe[title="React component preview"]');
  await expect(frame.getByText('Contact us', { exact: true })).toBeVisible();
  const proposalDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export screen proposal JSON', exact: true }).click();
  const proposal = parseReactScreenProposal(
    await readFile((await (await proposalDownload).path())!, 'utf8'),
  );
  expect(proposal.composition.inputs).toHaveProperty('name');
  expect(proposal.externalReferences).toMatchObject([
    { namespace: 'reference-host', stateId: 'draft' },
  ]);
  expect(proposal.externalReferences[0].screenId).toBeTruthy();
  expect(proposal.screenshotWidths).toEqual([390, 1024, 1400]);
  expect(proposal.screenshots).toEqual([]);
  await page.getByRole('button', { name: 'input · Input', exact: true }).click();
  await page.getByLabel('Data binding value', { exact: true }).selectOption('');
  await page.getByLabel('Callback binding onChange', { exact: true }).selectOption('');
  await page.getByLabel('Prop label', { exact: true }).fill('Your name');
  await expect(page.getByLabel('Data binding value', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Callback binding onChange', { exact: true })).toHaveValue('');
  await applyBindings(page);
  await expect(page.getByLabel('Prop value', { exact: true })).toBeEnabled();
  await page.getByLabel('Prop label', { exact: true }).fill('Name');
  await page.getByLabel('Data binding value', { exact: true }).selectOption({ label: 'name' });
  await page
    .getByLabel('Callback binding onChange', { exact: true })
    .selectOption({ label: 'onNameChange' });
  await applyBindings(page);
  await expect(page.getByLabel('Prop value', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Interact', exact: true }).click();
  await expect(page.locator('iframe[title="React component preview"]')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await frame.getByRole('textbox', { name: 'Name', exact: true }).fill('Aki');
  await expect(frame.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Aki');
  await frame.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(frame.getByText('Thanks Aki', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit composition', exact: true }).click();
  await page.getByRole('button', { name: 'buy · Button', exact: true }).click();
  await page.getByLabel('Prop variant', { exact: true }).selectOption('secondary');
  await page.getByRole('button', { name: 'Reset variant', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute(
    'data-variant',
    'secondary',
  );
  await save(page, 1);
  const before = await nativeArtifact(page);
  const content = before.draft.content as unknown as {
    fixture: { name: string };
    nodes: { id: string; bindings: object }[];
  };
  expect(content.fixture.name).toBe('');
  expect(content.nodes.find((n) => n.id === 'input')!.bindings).toMatchObject({
    value: { input: 'name' },
    onChange: { callback: 'onNameChange' },
  });
  await page.reload();
  await expect(frame.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
  await page.getByLabel('Import composition JSON', { exact: true }).setInputFiles({
    name: 'composition.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(before.draft.content)),
  });
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
});
test('W3 nested Library edits, slot movement, duplicate/delete and responsive token policy', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New React UI', exact: true }).click();
  await page.getByLabel('Target slot', { exact: true }).selectOption({ label: 'card / body' });
  await page.getByRole('button', { name: 'Insert Card', exact: true }).click();
  const record = await nativeArtifact(page);
  const nodes = (
    record.draft.content as unknown as {
      nodes: { id: string; component: { componentId: string } }[];
    }
  ).nodes;
  const nested = nodes.find((n) => n.id !== 'card' && n.component.componentId === 'Card')!.id;
  await page.getByLabel('Target slot', { exact: true }).selectOption({ label: `${nested} / body` });
  await page.getByRole('button', { name: 'Insert Text', exact: true }).click();
  await page.getByLabel('Prop text', { exact: true }).fill('Nested content');
  await page.getByRole('button', { name: `${nested} · Card`, exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate subtree', exact: true }).click();
  const frame = page.frameLocator('iframe[title="React component preview"]');
  await expect(frame.getByText('Nested content', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete subtree', exact: true }).click();
  await expect(frame.getByText('Nested content', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(frame.getByText('Nested content', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'title · Text', exact: true }).click();
  await page.getByLabel('Target slot', { exact: true }).selectOption({ label: 'card / footer' });
  await page.getByRole('button', { name: 'Move to target slot', exact: true }).click();
  await expect(frame.locator('footer').getByText('Color study', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load example Host tokens', exact: true }).click();
  await page.getByRole('button', { name: 'card · Card', exact: true }).click();
  await expect(page.getByLabel('Layout gap', { exact: true })).toHaveJSProperty(
    'tagName',
    'SELECT',
  );
  await page.getByLabel('Layout gap', { exact: true }).selectOption('token:space.gap');
  await expect(frame.getByRole('region', { name: 'Reference card' })).toHaveCSS('gap', '16px');
  await expect(page.getByLabel('Layout JSON', { exact: true })).toHaveCount(0);
  await page.getByLabel('Layout breakpoint', { exact: true }).selectOption('wide');
  await page.getByLabel('Layout display', { exact: true }).selectOption('flex');
  await page.getByLabel('Preview width', { exact: true }).selectOption('1400');
  await expect(frame.getByRole('region', { name: 'Reference card' })).toHaveCSS('display', 'flex');
  await page.screenshot({ path: info.outputPath('react-ui-w3-tokens-desktop.png') });
});
