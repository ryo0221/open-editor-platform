import { test as base, expect } from '@playwright/test';
import { test, nativeArtifact } from './fixtures';
import { sealReactEnvironment, type ReactUiDocument } from '@editor-platform/react-ui-core';

test('W5 unresolved native content stays intact, export fails, invalid import and read-only edits retain it', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New React UI', exact: true }).click();
  const initial = (await nativeArtifact(page)).draft.content as ReactUiDocument;
  const unresolved = {
    ...initial,
    environment: sealReactEnvironment({
      ...initial.environment,
      ref: { id: initial.environment.ref.id, version: 'unavailable' },
    }),
  };
  await page.getByLabel('Import composition JSON', { exact: true }).setInputFiles({
    name: 'composition.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(unresolved)),
  });
  await expect(page.getByRole('alert').filter({ hasText: 'runtime-unresolved' })).toBeVisible();
  await page.getByRole('button', { name: 'Export React TSX', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Export blocked' })).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual(unresolved);
  await page.getByLabel('Import composition JSON', { exact: true }).setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"domain":"react-ui"}'),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Import blocked' })).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual(unresolved);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'title · Text', exact: true }).click();
  await expect(page.getByLabel('Prop text', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Duplicate subtree', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Import composition JSON', { exact: true })).toBeDisabled();
  expect((await nativeArtifact(page)).draft.content).toEqual(unresolved);
});

// This case deliberately throws in a registered component. Permit only that exact error;
// every unrelated console/uncaught error still fails the acceptance check.
base(
  'W5 real component exception is contained by separate-origin boundary, draft survives and restart recovers',
  async ({ page }) => {
    const errors: Promise<string>[] = [];
    let previewOrigin = '';
    page.on('pageerror', (e) => errors.push(Promise.resolve(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error')
        errors.push(
          (async () => {
            // Firefox prints only "Error"; React's dev formatter puts the Error
            // after its format string. Check every actual Error argument/source.
            const messages = await Promise.all(
              m
                .args()
                .map((arg) =>
                  arg.evaluate((value) => (value instanceof Error ? value.message : null)),
                ),
            );
            if (new URL(m.location().url).origin !== previewOrigin)
              return `Unexpected error source: ${m.text()}`;
            return messages.filter((message) => message !== null).join('\n') || m.text();
          })(),
        );
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'New React UI', exact: true }).click();
    previewOrigin = new URL(
      (await page.locator('iframe[title="React component preview"]').getAttribute('src'))!,
      page.url(),
    ).origin;
    await page.getByRole('button', { name: 'title · Text', exact: true }).click();
    await page.getByLabel('Prop text', { exact: true }).fill('THROW_REFERENCE');
    await expect(page.getByRole('alert').filter({ hasText: 'component-exception' })).toBeVisible();
    const failed = (await nativeArtifact(page)).draft.content as ReactUiDocument;
    expect(failed.nodes.find((n) => n.id === 'title')!.props.text).toBe('THROW_REFERENCE');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Restart preview', exact: true }).click();
    const frame = page.frameLocator('iframe[title="React component preview"]');
    await expect(frame.getByText('Color study', { exact: true })).toBeVisible();
    await expect(page.locator('iframe[title="React component preview"]')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const error of await Promise.all(errors))
      expect(error).toBe('Reference component exception');
    expect(
      ((await nativeArtifact(page)).draft.content as ReactUiDocument).nodes.find(
        (n) => n.id === 'title',
      )!.props.text,
    ).toBe('Color study');
  },
);
