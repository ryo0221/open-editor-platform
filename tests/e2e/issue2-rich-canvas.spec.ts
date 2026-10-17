import { test, expect, create, nativeArtifact } from './fixtures';
import type { SlideContent } from '@editor-platform/slide';
import type { DesignContent } from '@editor-platform/design';
import type { WhiteboardContent } from '@editor-platform/whiteboard';

for (const kind of ['slide', 'design', 'whiteboard'] as const)
  test(`Canvas ${kind} selected text formatting commits once, cancels and exports rich runs`, async ({
    page,
  }) => {
    await page.goto('/');
    await create(page, kind);
    await page.getByRole('button', { name: 'Insert text', exact: true }).click();
    const canvas = page.getByRole('application', {
      name: `${kind[0].toUpperCase() + kind.slice(1)} canvas`,
    });
    await canvas
      .getByRole('button')
      .filter({ has: page.locator('text') })
      .first()
      .dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    // Use ProseMirror's Select All command, as in issue2-slide: fill() only
    // selects the DOM range, which a pending editor selection sync can replace.
    await editor.press('Control+a');
    await page.keyboard.insertText('日本語の計画を確認する');
    // Layout widgets may visually wrap runs; assert the complete text content.
    await expect(editor).toHaveJSProperty('textContent', '日本語の計画を確認する');
    await editor.press('Control+Home');
    await editor.press('Shift+ArrowRight');
    await editor.press('Shift+ArrowRight');
    await editor.press('Shift+ArrowRight');
    await expect
      .poll(() =>
        editor.evaluate((element) => {
          const selection = window.getSelection();
          return selection?.anchorNode && element.contains(selection.anchorNode)
            ? selection.toString()
            : null;
        }),
      )
      .toBe('日本語');
    await page.getByRole('button', { name: 'Selected text bold', exact: true }).click();
    await page.getByLabel('Selected text color', { exact: true }).fill('#cc3300');
    await expect(editor.locator('strong')).toHaveText('日本語');
    await editor.press('Control+Enter');
    const content = (await nativeArtifact(page)).draft.content as
      | SlideContent
      | DesignContent
      | WhiteboardContent;
    const elements =
      'slides' in content
        ? content.slides[0].objects
        : 'elements' in content
          ? content.elements
          : content.nodes;
    expect(
      elements.find((element) => ('type' in element ? element.type : element.kind) === 'text')!
        .text,
    ).toBe('日本語の計画を確認する');
    expect(JSON.stringify(content)).toContain('"bold":true');
    expect(JSON.stringify(content)).toContain('#cc3300');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(JSON.stringify((await nativeArtifact(page)).draft.content)).not.toContain('日本語');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(content);
    await page.getByLabel('Canvas zoom', { exact: true }).selectOption('2');
    const target = canvas
      .getByRole('button')
      .filter({ has: page.locator('text') })
      .first();
    const area = (await canvas.boundingBox())!,
      object = (await target.boundingBox())!;
    await canvas.focus();
    await page.keyboard.down('Space');
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      area.x + area.width - object.x - object.width / 2 + area.x,
      area.y + area.height - object.y - object.height / 2 + area.y,
      { steps: 5 },
    );
    await page.mouse.up();
    await page.keyboard.up('Space');
    await canvas
      .getByRole('button')
      .filter({ has: page.locator('text') })
      .first()
      .dblclick();
    const popup = await canvas.locator('foreignObject').boundingBox(),
      viewport = (await canvas.boundingBox())!;
    expect(popup!.x).toBeGreaterThanOrEqual(viewport.x);
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(
      (await page.getByRole('button', { name: 'Selected text bold', exact: true }).boundingBox())!
        .height,
    ).toBeLessThan(45);
    await editor.press('Control+a');
    await page.keyboard.insertText('取消する');
    await expect(editor).toHaveJSProperty('textContent', '取消する');
    await editor.press('Escape');
    expect((await nativeArtifact(page)).draft.content).toEqual(content);
    await page.reload();
    await expect(canvas.locator('tspan[font-weight="700"]')).toContainText('日本語');
    await page.getByRole('button', { name: 'Insert text', exact: true }).click();
    for (const [label, value] of [
      // Distinct from each native default (Whiteboard 18px, Slide/Design 28px).
      // Formatting a run must not silently change the first node's default size.
      ['Font size (px)', '36'],
      ['Text color', '#00aa00'],
    ]) {
      await page.getByLabel(label, { exact: true }).fill(value);
      await page.getByLabel(label, { exact: true }).press('Enter');
    }
    await canvas.focus();
    await canvas.press('Control+a');
    await expect(page.getByLabel('Font size (px)', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Font size (px)', { exact: true })).toHaveAttribute(
      'placeholder',
      'Mixed',
    );
    await page.getByLabel('Font size (px)', { exact: true }).fill('24');
    await page.getByLabel('Font size (px)', { exact: true }).press('Enter');
    const updated = JSON.stringify((await nativeArtifact(page)).draft.content);
    expect(updated).toContain('"fontSize":24');
    expect(updated).toContain('#00aa00');
    expect(updated).toContain('#cc3300');
  });
