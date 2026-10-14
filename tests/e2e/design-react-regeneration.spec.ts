import { test, expect, nativeArtifact, create, save } from './fixtures';
import type { DesignContent } from '@editor-platform/design/model';
import { authorDesignReact, layer } from './design-react-fixtures';
import { value } from './practical-fixtures';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';
import type { Page } from '@playwright/test';
async function activate(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Artifacts', exact: true });
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await nav.getByRole('button').filter({ hasText: name }).click();
}
test('#29 normal UI regeneration keeps React-side props, applies independent native edits and blocks conflicts', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(12000);
  const native = await authorDesignReact(page),
    designName = await page.getByLabel('Artifact name').inputValue();
  const buy = native.elements.find((e) => e.react?.props.label === 'Buy now')!;
  await page
    .getByRole('button', { name: 'Register native components for React UI', exact: true })
    .click();
  const targetName = await page.getByLabel('Artifact name').inputValue();
  const target = await nativeArtifact(page);
  await page.getByRole('button', { name: `${buy.id} · Button`, exact: true }).click();
  await page.getByLabel('Prop label', { exact: true }).fill('React side edit');
  await expect(
    page
      .frameLocator('iframe[title="React component preview"]')
      .getByRole('button', { name: 'React side edit' }),
  ).toBeVisible();
  await activate(page, designName);
  await layer(page, 'Contact link');
  await value(page, 'Text', 'Updated native link');
  await page.getByLabel('React UI regeneration target', { exact: true }).selectOption(target.id);
  await page.getByRole('button', { name: 'Review React UI regeneration', exact: true }).click();
  let review = page.getByRole('dialog', { name: 'Review React UI regeneration', exact: true });
  await expect(review.getByRole('button', { name: 'Accept React UI regeneration' })).toBeEnabled();
  await review.getByRole('button', { name: 'Accept React UI regeneration' }).click();
  await activate(page, targetName);
  let updated = (await nativeArtifact(page)).draft.content as ReactUiDocument;
  expect(updated.nodes.find((n) => n.id === buy.id)?.props.label).toBe('React side edit');
  expect(updated.nodes.some((n) => n.props.text === 'Updated native link')).toBe(true);
  await page.reload();
  expect(
    ((await nativeArtifact(page)).draft.content as ReactUiDocument).nodes.find(
      (n) => n.id === buy.id,
    )?.props.label,
  ).toBe('React side edit');
  await activate(page, designName);
  await layer(page, 'Buy Button');
  await value(page, 'React prop label', 'Native side conflicting edit');
  await page.getByLabel('React UI regeneration target', { exact: true }).selectOption(target.id);
  await page.getByRole('button', { name: 'Review React UI regeneration', exact: true }).click();
  review = page.getByRole('dialog', { name: 'Review React UI regeneration', exact: true });
  await expect(review.locator('pre')).toContainText(buy.id + '/props');
  await expect(review.getByRole('button', { name: 'Accept React UI regeneration' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('design-react-regeneration-conflict.png') });
  await review.getByRole('button', { name: 'Close regeneration review' }).click();
  await activate(page, targetName);
  updated = (await nativeArtifact(page)).draft.content as ReactUiDocument;
  expect(updated.nodes.find((n) => n.id === buy.id)?.props.label).toBe('React side edit');
});
test('#29 ordinary Design retains original pins across explicit revision and full native artifact import', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(12000);
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Enable React Web', exact: true }).click();
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await value(page, 'Layer name', 'Mapped original Text');
  const beforeMap = (await nativeArtifact(page)).draft.content as DesignContent;
  await page
    .getByLabel('Map selected native element to React', { exact: true })
    .selectOption({ label: 'Text @1.0.0' });
  await value(page, 'React prop text', 'Pinned original literal');
  await save(page, 1);
  await layer(page, 'Mapped original Text');
  const pinned = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(pinned.elements[0].id).toBe(beforeMap.elements[0].id);
  expect(pinned.elements[0].bounds).toEqual(beforeMap.elements[0].bounds);
  await page.getByRole('button', { name: 'Adopt React Text @2.0.0', exact: true }).click();
  await expect(page.getByLabel('React prop content', { exact: true })).toHaveValue(
    'Pinned original literal',
  );
  await save(page, 2);
  const exported = await nativeArtifact(page),
    next = exported.draft.content as DesignContent;
  expect(next.elements[0].id).toBe(pinned.elements[0].id);
  expect(next.elements[0].bounds).toEqual(pinned.elements[0].bounds);
  expect(next.elements[0].react?.component.version).toBe('2.0.0');
  expect((exported.versions[0].content as DesignContent).elements[0].react?.component.version).toBe(
    '1.0.0',
  );
  if (!(await page.getByLabel('Import artifact', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'native-design.artifact.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect.poll(async () => (await nativeArtifact(page)).id).not.toBe(exported.id);
  const imported = await nativeArtifact(page);
  expect(imported.draft.content).toEqual(next);
  expect(imported.versions.map((v) => v.content)).toEqual(exported.versions.map((v) => v.content));
  await layer(page, 'Mapped original Text');
  await page.getByRole('button', { name: 'Preview selected Design as React', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Design React preview', exact: true });
  await expect(
    dialog.frameLocator('iframe').getByText('Pinned original literal', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('design-original-native-revision-import.png') });
});
