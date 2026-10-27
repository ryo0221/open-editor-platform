import { test, expect, create, nativeArtifact } from './fixtures';
import type { Page } from '@playwright/test';
import type { SlideContent } from '@editor-platform/slide/model';

// Issue #377: centred Animation placement, playback position in seconds and frames,
// provisional system font for text without a pinned font, and the shared editor look.
async function tool(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  const more = page.getByRole('button', { name: 'More editor tools', exact: true });
  await expect(button.or(more).first()).toBeVisible();
  if (!(await button.isVisible())) await more.click();
  await button.click();
}
async function importRecord(page: Page, record: unknown) {
  const field = page.getByLabel('Import artifact', { exact: true });
  if (!(await field.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await field.setInputFiles({
    name: 'animation.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
}

test('Japanese text without a font plays in the system font and the Slide places it centred', async ({
  page,
}, info) => {
  const { createAnimation2, createAnimationLayer2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { createArtifact, commitVersion } = await import('@editor-platform/artifact-core');
  const content = createAnimation2(),
    root = content.compositions[0],
    title = createAnimationLayer2('text', 'title', root.duration);
  if (title.type !== 'text') throw Error();
  title.name = '見出し';
  title.text = '洋上風力';
  title.runs = [{ text: title.text }];
  root.layers = [title];
  const source = await commitVersion(
    createArtifact('animation', '発電アニメーション', content),
    'test',
    'Original',
  );
  await page.goto('/');
  await importRecord(page, source);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(source.name);

  const editor = page.getByRole('region', { name: 'Animation 2D editor', exact: true });
  await expect(editor.locator('.animation-player2 svg text')).toHaveText('洋上風力');
  // Same toolbar line and panel borders as the editor-ui layout.
  await expect(editor.locator('.a2-toolbar')).toHaveCSS(
    'border-bottom-color',
    'rgb(223, 226, 230)',
  );
  await expect(editor.getByRole('navigation', { name: 'Animation layers' })).toHaveCSS(
    'border-right-color',
    'rgb(223, 226, 230)',
  );
  await editor.getByRole('button', { name: 'text 見出し', exact: true }).click();
  await expect(
    editor.getByText('System font preview: pin a font asset to fix how this text looks.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('animation-editor.png') });
  await editor.getByRole('button', { name: 'Export static frame…', exact: true }).click();
  await expect(
    editor.getByText(/Pin a font asset for non-ASCII text before exporting a static frame/),
  ).toBeVisible();
  await expect(editor.getByRole('group', { name: 'Static export confirmation' })).toHaveCount(0);

  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  await page.getByRole('button', { name: 'この版を配置', exact: true }).click();
  const deck = (await nativeArtifact(page)).draft.content as SlideContent,
    placed = deck.slides[0].objects.find((o) => o.type === 'animation')!;
  // 640 × 360 source on a 960 × 540 slide: 16:9, centred inside the margin.
  expect(placed.bounds).toEqual({ x: 77, y: 43, width: 807, height: 454 });
  await page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .getByRole('button', { name: /^animation object/ })
    .click();
  const note = page.getByText(
    '端末のフォントで仮表示しています。見た目を固定するには、元の Animation で text にフォントを指定してください。',
    { exact: true },
  );
  if (!(await note.isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  await expect(note).toBeVisible();
  await page.screenshot({ path: info.outputPath('slide-placed.png') });

  await tool(page, 'Present');
  const presentation = page.getByRole('dialog', { name: 'Slide presentation', exact: true });
  await presentation
    .getByRole('button', { name: /^(Pause|Play) animation$/ })
    .first()
    .click();
  const range = presentation.getByLabel('Animation tick', { exact: true });
  await range.fill('240000');
  const position = presentation.locator('output').first();
  await expect(position).toHaveText('1.00 s / 4.00 s · Frame 30');
  await expect(range).toHaveAttribute('aria-valuetext', '1.00 s / 4.00 s · Frame 30');
  await expect(presentation.locator('svg text').first()).toHaveText('洋上風力');
  await page.screenshot({ path: info.outputPath('slide-present.png') });
});
