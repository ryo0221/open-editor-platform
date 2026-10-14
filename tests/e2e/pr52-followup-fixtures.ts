import { expect, type Page } from '@playwright/test';
import { nativeArtifact, create, save, tinyPng } from './fixtures';
import { artifactMenu } from './template-fixtures';
import { confirmed } from './practical-fixtures';
import { importUsability } from './usability-fixtures';
import { dataProjection, independentSource } from './structured-graph-fixtures';
import { auditData } from './audit-fixtures';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { originalBytes, type FileContent } from '@editor-platform/review-surfaces/model';
import { createDesign, createComponent, makeDesignElement } from '@editor-platform/design/model';
import { publicationParts, publishDesignComponent } from '@editor-platform/design/publication';

/** Use ordinary controls without blurring the private Form buffer first. */
export async function sharedFormStart(page: Page) {
  await page.goto('/');
  const data = auditData();
  data.columns[0].required = true;
  await importUsability(page, 'data', data);
  await save(page, 1);
  const original = await nativeArtifact(page);
  await dataProjection(page, 'Form');
  const field = page.getByLabel('Record Name', { exact: true });
  const start = async () => {
    await page
      .getByRole('button', { name: 'More artifact actions', exact: true })
      .dispatchEvent('click');
    await page
      .getByRole('button', { name: 'Open collaboratively', exact: true })
      .dispatchEvent('click');
  };
  await field.fill('');
  await start();
  await expect(page.locator('.error-banner')).toContainText('Name');
  await expect(page).not.toHaveURL(/shared=/);
  await expect(field).toHaveValue('');
  await page.keyboard.press('Escape');
  await field.fill('Seeded private Form input');
  await field.dispatchEvent('compositionstart');
  await start();
  await expect(page.locator('.error-banner')).toContainText('入力変換');
  await expect(page).not.toHaveURL(/shared=/);
  await expect(field).toHaveValue('Seeded private Form input');
  await field.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await field.focus();
  await expect(field).toBeFocused();
  await start();
  await expect(page).toHaveURL(/shared=/);
  await confirmed(page);
  const shared = await nativeArtifact(page);
  const content = shared.draft.content as StructuredData;
  expect(content.rows[0].values.title).toBe('Seeded private Form input');
  expect(content.rows.map((row) => row.id)).toEqual(data.rows.map((row) => row.id));
  expect(shared.versions).toEqual(original.versions);
  await page.reload();
  await confirmed(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(content);
}

const embeddedContent = async (page: Page): Promise<StructuredData> =>
  JSON.parse((await page.locator('.embed-content pre').textContent())!);

export async function independentFormSwitch(page: Page, retainedScreenshot?: string) {
  await page.goto('/embed.html');
  const surface = page.getByLabel('Surface', { exact: true });
  await surface.selectOption('data');
  await dataProjection(page, 'Form');
  const original = await embeddedContent(page);
  const nameColumn = original.columns.find((column) => column.name === 'Name')!.id;
  const quantity = page.getByLabel('Record Quantity', { exact: true });
  const field = page.getByLabel('Record Name', { exact: true });
  await quantity.fill('invalid number');
  await surface.selectOption('slide');
  await expect(surface).toHaveValue('data');
  await expect(page.getByRole('alert').filter({ hasText: 'Data Form:' })).toContainText('Quantity');
  await expect(quantity).toHaveValue('invalid number');
  expect(await embeddedContent(page)).toEqual(original);
  await quantity.fill('1');
  await field.fill('Retained across Host surfaces');
  await field.dispatchEvent('compositionstart');
  await surface.selectOption('slide');
  await expect(surface).toHaveValue('data');
  await expect(page.getByRole('alert').filter({ hasText: 'Data Form:' })).toContainText('入力変換');
  await expect(field).toHaveValue('Retained across Host surfaces');
  expect(await embeddedContent(page)).toEqual(original);
  await field.dispatchEvent('compositionend');
  await surface.selectOption('slide');
  await expect(surface).toHaveValue('slide');
  await surface.selectOption('data');
  const retained = await embeddedContent(page);
  expect(retained.rows[0].values[nameColumn]).toBe('Retained across Host surfaces');
  expect(retained.rows.map((row) => row.id)).toEqual(original.rows.map((row) => row.id));
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await embeddedContent(page)).rows[0].values[nameColumn]).toBe(
    original.rows[0].values[nameColumn],
  );
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  expect(await embeddedContent(page)).toEqual(retained);
  if (retainedScreenshot) {
    await page.getByRole('button', { name: 'Host navigator', exact: true }).click();
    await dataProjection(page, 'Form');
    await page.screenshot({ path: retainedScreenshot });
  }
  await page.goto('/embed.html?rejected-input=1');
  const rejected = page.getByLabel('Rejected field', { exact: true });
  await rejected.fill('Host refused input');
  await surface.selectOption('data');
  await expect(surface).toHaveValue('slide');
  await expect(rejected).toHaveValue('Host refused input');
  await expect(page.getByRole('alert').filter({ hasText: 'Rejected field' })).toBeVisible();
  await rejected.press('Escape');
  await surface.selectOption('data');
  await expect(surface).toHaveValue('data');
}

export async function sharedFormDetach(page: Page) {
  await page.goto('/');
  const data = auditData();
  data.columns[0].required = true;
  await importUsability(page, 'data', data);
  await save(page, 1);
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const response = await page.request.post('/collaboration-api/editor/session', {
    data: {
      actor: 'B',
      artifactId: new URL(page.url()).searchParams.get('shared')!,
      domain: 'data',
    },
  });
  expect(response.ok()).toBe(true);
  const configuration = { ...(await response.json()), domain: 'data' };
  await page.goto('/embed.html');
  await page.evaluate(
    (value) => sessionStorage.setItem('ep-independent-host', JSON.stringify(value)),
    configuration,
  );
  await page.reload();
  await expect(page.getByLabel('Host sync status')).toContainText('confirmed');
  await expect(page.getByLabel('Host versions')).toHaveText('1 saved version(s)');
  await dataProjection(page, 'Form');
  const original = await embeddedContent(page);
  const field = page.getByLabel('Record Name', { exact: true });
  const detach = page.getByRole('button', { name: 'Detach editor', exact: true });
  await field.fill('');
  await detach.dispatchEvent('click');
  await expect(page.getByRole('alert').filter({ hasText: 'Data Form:' })).toContainText('Name');
  await expect(field).toHaveValue('');
  expect(await embeddedContent(page)).toEqual(original);
  await field.fill('Checkpointed before detach');
  await field.dispatchEvent('compositionstart');
  await detach.dispatchEvent('click');
  await expect(page.getByRole('alert').filter({ hasText: 'Data Form:' })).toContainText('入力変換');
  await expect(field).toHaveValue('Checkpointed before detach');
  expect(await embeddedContent(page)).toEqual(original);
  await field.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Pause connection', exact: true }).dispatchEvent('click');
  await expect(field).toBeFocused();
  await detach.dispatchEvent('click');
  await expect(page.getByLabel('Surface', { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).some((key) => key.startsWith('ep-independent-pending:')),
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Attach editor', exact: true }).click();
  await expect(page.getByLabel('Host sync status')).toContainText('confirmed');
  await expect(page.getByLabel('Host versions')).toHaveText('1 saved version(s)');
  const retained = await embeddedContent(page);
  expect(retained.rows[0].values.title).toBe('Checkpointed before detach');
  expect(retained.rows.map((row) => row.id)).toEqual(original.rows.map((row) => row.id));
  await page.reload();
  await expect(page.getByLabel('Host sync status')).toContainText('confirmed');
  expect(await embeddedContent(page)).toEqual(retained);
}

export async function imageFirstPublicSlot(page: Page) {
  const image = {
    ...makeDesignElement('image'),
    id: 'first-image',
    name: 'First image',
    src: `data:image/png;base64,${tinyPng.toString('base64')}`,
  };
  const body = { ...makeDesignElement('frame'), id: 'slot-body', name: 'Slot body' };
  const allowed = {
    ...makeDesignElement('text'),
    id: 'allowed-text',
    name: 'Allowed text',
    text: 'Allowed',
  };
  let design = { ...createDesign(), elements: [image, body, allowed] };
  design = createComponent([image.id, body.id], 'image-first').apply(design);
  design = createComponent(allowed.id, 'allowed-component').apply(design);
  const allowedPart = publicationParts(
    design.components.find((c) => c.id === 'allowed-component')!,
  )[0];
  design = publishDesignComponent(
    design,
    'allowed-component',
    { symbol: 'AllowedText', version: '1.0.0', props: {}, variants: {} },
    { [allowedPart.id]: 'p' },
  ).apply(design);
  await page.goto('/');
  await importUsability(page, 'design', design);
  const open = async () => {
    const components = page.getByRole('button', { name: 'Components', exact: true });
    if (!(await components.isVisible()))
      await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
    await components.click();
    await page.getByRole('button', { name: 'React公開設定 First image', exact: true }).click();
  };
  await open();
  const slot = page.getByLabel('Public slot part', { exact: true });
  const add = page.getByRole('button', { name: 'Add public slot', exact: true });
  const imageTag = page.getByLabel('HTML meaning First image', { exact: true });
  const bodyTag = page.getByLabel('HTML meaning Slot body', { exact: true });
  await expect(slot.locator('option')).toHaveCount(1);
  await expect(slot).toHaveValue(body.id);
  await expect(add).toBeEnabled();
  await bodyTag.selectOption('img');
  await expect(slot.locator('option')).toHaveCount(0);
  await expect(slot).toHaveValue('');
  await expect(add).toBeDisabled();
  expect(
    await imageTag
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
  ).toEqual(['', 'img']);
  await bodyTag.selectOption('section');
  await slot.selectOption(body.id);
  await bodyTag.selectOption('img');
  await expect(slot).toHaveValue('');
  await expect(add).toBeDisabled();
  await bodyTag.selectOption('div');
  await expect(slot).toHaveValue(body.id);
  await add.click();
  await expect(page.getByRole('button', { name: 'Remove slot body', exact: true })).toBeVisible();
  await bodyTag.selectOption('img');
  await expect(page.getByRole('alert').filter({ hasText: '公開slot body' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save React publication settings', exact: true }),
  ).toBeDisabled();
  await bodyTag.selectOption('div');
  await page.getByRole('button', { name: 'Save React publication settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'React component publication' })).toHaveCount(0);
  const published = (await nativeArtifact(page)).draft.content as typeof design;
  const component = published.components.find((c) => c.id === 'image-first')!;
  expect(component.web?.slots?.body).toMatchObject({
    elementId: body.id,
    prop: 'children',
    accepts: [{ registryId: 'native-design', componentId: 'allowed-component' }],
  });
  expect(publicationParts(component).map((part) => part.id)).toEqual([image.id, body.id]);
  await page.keyboard.press('Control+z');
  expect((await nativeArtifact(page)).draft.content).toEqual(design);
  await page.keyboard.press('Control+Shift+z');
  expect((await nativeArtifact(page)).draft.content).toEqual(published);
  await page.reload();
  await open();
  await expect(slot).toHaveValue(body.id);
  await expect(page.getByRole('button', { name: 'Remove slot body', exact: true })).toBeVisible();
}

/** Invoke the ordinary Host button without moving focus out of the buffered field. */
export async function fieldSettingsSave(page: Page) {
  await page.goto('/graph-host.html');
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await dataProjection(page, 'Grid');
  const addField = page.getByRole('button', { name: 'Add field', exact: true });
  if (!(await addField.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('New field name', { exact: true }).fill('Amount');
  await page.getByLabel('New field type', { exact: true }).selectOption('number');
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
  const fieldButton = page.getByRole('button', { name: 'Amount', exact: true });
  if (!(await fieldButton.isVisible()))
    await page.getByRole('button', { name: 'Toggle Data navigator', exact: true }).click();
  await fieldButton.click();
  const input = page.getByLabel('Decimal places', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle Data inspector', exact: true }).click();
  const before = await independentSource<StructuredData>(page);
  const amount = before.columns.find((column) => column.name === 'Amount')!;
  await input.fill('4');
  await expect(input).toBeFocused();
  expect(
    (await independentSource<StructuredData>(page)).columns.find((c) => c.id === amount.id)
      ?.decimals,
  ).toBeUndefined();
  await page.getByRole('button', { name: 'Save draft', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await expect(input).toBeFocused();
  const saved = await independentSource<StructuredData>(page);
  expect(saved.columns.find((c) => c.id === amount.id)?.decimals).toBe(4);
  expect(saved.rows).toEqual(before.rows);
  await input.fill('');
  await page.getByRole('button', { name: 'Save draft', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('alert').filter({ hasText: 'Decimal places' })).toBeVisible();
  expect(await independentSource(page)).toEqual(saved);
  await expect(input).toHaveValue('');
  for (const invalid of ['9', '2.5']) {
    await input.fill(invalid);
    await page.getByRole('button', { name: 'Save draft', exact: true }).dispatchEvent('click');
    await expect(page.getByRole('alert').filter({ hasText: 'Decimal places' })).toBeVisible();
    expect(await independentSource(page)).toEqual(saved);
    await expect(input).toHaveValue(invalid);
  }
  await input.fill('5');
  await input.dispatchEvent('compositionstart');
  await page.getByRole('button', { name: 'Save draft', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('alert').filter({ hasText: '入力変換' })).toBeVisible();
  expect(await independentSource(page)).toEqual(saved);
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: 'Save draft', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  const final = await independentSource<StructuredData>(page);
  expect(final.columns.find((c) => c.id === amount.id)?.decimals).toBe(5);
  await page.reload();
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Reloaded locally');
  expect(await independentSource(page)).toEqual(final);
}

export async function sharedFormSave(page: Page) {
  await page.goto('/');
  const data = auditData();
  data.columns[0].required = true;
  await importUsability(page, 'data', data);
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const artifactId = new URL(page.url()).searchParams.get('shared')!;
  const response = await page.request.post('/collaboration-api/editor/session', {
    data: { actor: 'B', artifactId, domain: 'data' },
  });
  expect(response.ok()).toBe(true);
  const configuration = { ...(await response.json()), domain: 'data' };
  await page.goto('/embed.html');
  await page.evaluate(
    (value) => sessionStorage.setItem('ep-independent-host', JSON.stringify(value)),
    configuration,
  );
  await page.reload();
  await expect(page.getByLabel('Host sync status')).toContainText('confirmed');
  await dataProjection(page, 'Form');
  const field = page.getByLabel('Record Name', { exact: true });
  const content = async () => JSON.parse((await page.locator('.embed-content pre').textContent())!);
  const saveVersion = async () => {
    const button = page.getByRole('button', { name: 'Host save version', exact: true });
    await button.focus();
    await button.press('Enter');
  };
  await field.fill('Unapplied shared Form');
  expect((await content()).rows[0].values.title).toBe('First period');
  await saveVersion();
  await expect(page.getByLabel('Host versions')).toHaveText('1 saved version(s)');
  expect((await content()).rows[0].values.title).toBe('Unapplied shared Form');
  await field.fill('');
  await saveVersion();
  await expect(page.getByRole('alert').filter({ hasText: 'Data Form:' })).toContainText('Name');
  await expect(field).toHaveValue('');
  expect((await content()).rows[0].values.title).toBe('Unapplied shared Form');
  await expect(page.getByLabel('Host versions')).toHaveText('1 saved version(s)');
  await field.fill('Retained composition');
  await field.dispatchEvent('compositionstart');
  await saveVersion();
  await expect(page.getByRole('alert').filter({ hasText: 'Data Form:' })).toContainText('入力変換');
  await expect(field).toHaveValue('Retained composition');
  await expect(page.getByLabel('Host versions')).toHaveText('1 saved version(s)');
  await field.dispatchEvent('compositionend');
  await saveVersion();
  await expect(page.getByLabel('Host versions')).toHaveText('2 saved version(s)');
  const saved = await content();
  expect(saved.rows[0].values.title).toBe('Retained composition');
  await page.reload();
  await expect(page.getByLabel('Host sync status')).toContainText('confirmed');
  await expect(page.getByLabel('Host versions')).toHaveText('2 saved version(s)');
  expect(await content()).toEqual(saved);
}

export async function replacementEncoding(page: Page) {
  await page.goto('/');
  await create(page, 'file');
  const original = (await nativeArtifact(page)).draft.content;
  const text = '文字コード変更後の日本語\nUTF-8の原本!';
  const bytes = Buffer.from(text, 'utf8');
  if (!(await page.getByRole('button', { name: 'Replace source', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await page.getByRole('button', { name: 'Replace source', exact: true }).click();
  await page.getByLabel('File text encoding').selectOption('utf-16le');
  await page.getByLabel('Open file', { exact: true }).setInputFiles({
    name: 'utf8.txt',
    mimeType: 'text/plain',
    buffer: bytes,
  });
  await expect(
    page.getByRole('button', { name: 'Confirm source replacement', exact: true }),
  ).toBeEnabled();
  await page.getByLabel('File text encoding').selectOption('utf-8');
  await page.getByRole('button', { name: 'Confirm source replacement', exact: true }).click();
  await expect(page.getByText('文字コード変更後の日本語', { exact: true })).toBeVisible();
  const replaced = (await nativeArtifact(page)).draft.content as FileContent;
  expect(replaced.data).toBe(text);
  expect(Buffer.from(originalBytes(replaced))).toEqual(bytes);
  await page.keyboard.press('Control+z');
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
  await page.keyboard.press('Control+Shift+z');
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(replaced);
}

/** Leave must flush private buffers and wait for authority confirmation before detaching. */
export async function sharedFormLeave(page: Page) {
  await page.goto('/');
  const data = auditData();
  data.columns[0].required = true;
  await importUsability(page, 'data', data);
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const sharedUrl = page.url();
  const artifactId = new URL(sharedUrl).searchParams.get('shared')!;
  await dataProjection(page, 'Form');
  const field = page.getByLabel('Record Name', { exact: true });
  async function leave() {
    await page
      .getByRole('button', { name: 'More artifact actions', exact: true })
      .dispatchEvent('click');
    await page
      .getByRole('button', { name: 'Leave shared session', exact: true })
      .dispatchEvent('click');
  }
  await field.fill('');
  await leave();
  await expect(page.locator('.error-banner')).toContainText('Name');
  await expect(field).toHaveValue('');
  expect(page.url()).toBe(sharedUrl);
  await page.keyboard.press('Escape');
  await field.fill('Confirmed before leaving');
  await field.dispatchEvent('compositionstart');
  await leave();
  await expect(page.locator('.error-banner')).toContainText('入力変換');
  await expect(field).toHaveValue('Confirmed before leaving');
  expect(page.url()).toBe(sharedUrl);
  await field.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await leave();
  await expect(page).not.toHaveURL(/shared=/);
  const response = await page.request.post('/collaboration-api/editor/session', {
    data: { actor: 'B', artifactId, domain: 'data' },
  });
  expect(response.ok()).toBe(true);
  const configuration = { ...(await response.json()), domain: 'data' };
  await page.goto('/embed.html');
  await page.evaluate(
    (value) => sessionStorage.setItem('ep-independent-host', JSON.stringify(value)),
    configuration,
  );
  await page.reload();
  await expect(page.getByLabel('Host sync status')).toContainText('confirmed');
  const content = JSON.parse((await page.locator('.embed-content pre').textContent())!);
  expect(content.rows[0].values.title).toBe('Confirmed before leaving');
}
