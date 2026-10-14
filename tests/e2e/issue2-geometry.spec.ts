import { test, expect, create, nativeArtifact } from './fixtures';
import type { SlideContent } from '@editor-platform/slide';

test('QA-05 eight rotated handles follow the pointer at 25/100/200 percent after pan; cancel and undo keep content', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await create(page, 'slide');
  await page.getByRole('button', { name: 'Insert shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Insert rectangle', exact: true }).click();
  await page.keyboard.press('Escape');
  for (const [label, value] of [
    ['Element x', '100'],
    ['Element y', '100'],
    ['Element width', '200'],
    ['Element height', '120'],
    ['Rotation (°)', '30'],
  ]) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(value);
    await input.press('Enter');
  }
  const canvas = page.getByRole('application', { name: 'Slide canvas' });
  const initial = (await nativeArtifact(page)).draft.content as SlideContent;
  const original = initial.slides[0].objects[0];
  await canvas.focus();
  await page.keyboard.down('Space');
  const area = (await canvas.boundingBox())!;
  await page.mouse.move(area.x + 10, area.y + 10);
  await page.mouse.down();
  await page.mouse.move(area.x + 70, area.y + 50, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect((await nativeArtifact(page)).draft.content).toEqual(initial);
  for (const zoom of [0.25, 1, 2]) {
    await page.getByLabel('Canvas zoom', { exact: true }).selectOption(String(zoom));
    const object = canvas.getByRole('button', { name: 'shape object 1', exact: true });
    await canvas.click({ position: { x: 8, y: 8 } });
    await expect(object).toHaveAttribute('aria-pressed', 'false');
    const ob = (await object.boundingBox())!;
    await page.mouse.move(ob.x - 8, ob.y - 8);
    await page.mouse.down();
    await page.mouse.move(ob.x + ob.width + 8, ob.y + ob.height + 8, { steps: 5 });
    await page.mouse.up();
    await expect(object).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.down('Alt');
    await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
    await page.mouse.down();
    await page.mouse.move(ob.x + ob.width / 2 + 20 * zoom, ob.y + ob.height / 2 - 10 * zoom, {
      steps: 5,
    });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const moved = ((await nativeArtifact(page)).draft.content as SlideContent).slides[0].objects[0];
    expect(moved.bounds.x).toBeCloseTo(original.bounds.x + 20, 0);
    expect(moved.bounds.y).toBeCloseTo(original.bounds.y - 10, 0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    const rotate = (await canvas
      .getByRole('button', { name: 'Rotate selection', exact: true })
      .boundingBox())!;
    const cx = ob.x + ob.width / 2,
      cy = ob.y + ob.height / 2;
    const rx = rotate.x + rotate.width / 2 - cx,
      ry = rotate.y + rotate.height / 2 - cy;
    await page.mouse.move(cx + rx, cy + ry);
    await page.mouse.down();
    await page.mouse.move(
      cx + rx * Math.cos(Math.PI / 6) - ry * Math.sin(Math.PI / 6),
      cy + rx * Math.sin(Math.PI / 6) + ry * Math.cos(Math.PI / 6),
      { steps: 8 },
    );
    await page.mouse.up();
    expect(
      ((await nativeArtifact(page)).draft.content as SlideContent).slides[0].objects[0].rotation,
    ).toBeCloseTo(60, 0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(initial);
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const grip = canvas.getByRole('button', {
        name: handle === 'se' ? 'Resize shape object 1' : `Resize ${handle}`,
        exact: true,
      });
      const point = (await grip.boundingBox())!;
      expect(
        await page.evaluate(
          ({ x, y, width, height }) =>
            document.elementFromPoint(x + width / 2, y + height / 2)?.getAttribute('aria-label'),
          point,
        ),
        `handle hit at zoom=${zoom}, handle=${handle}`,
      ).toBe(await grip.getAttribute('aria-label'));
      const dx = handle.includes('w') ? -20 : handle.includes('e') ? 20 : 0;
      const dy = handle.includes('n') ? -20 : handle.includes('s') ? 20 : 0;
      const angle = Math.PI / 6;
      await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        point.x + point.width / 2 + (dx * Math.cos(angle) - dy * Math.sin(angle)) * zoom,
        point.y + point.height / 2 + (dx * Math.sin(angle) + dy * Math.cos(angle)) * zoom,
        { steps: 5 },
      );
      await page.mouse.up();
      const after = ((await nativeArtifact(page)).draft.content as SlideContent).slides[0]
        .objects[0];
      expect(after.bounds.width, `zoom=${zoom}, handle=${handle}`).toBeCloseTo(
        original.bounds.width + Math.abs(dx),
        0,
      );
      expect(after.bounds.height, `zoom=${zoom}, handle=${handle}`).toBeCloseTo(
        original.bounds.height + Math.abs(dy),
        0,
      );
      expect(after.rotation).toBe(30);
      // Opposite handle is a fixed world point (center coordinates on the unchanged axis).
      const anchor = (b: typeof original.bounds) => {
        const x = handle.includes('w') ? b.width / 2 : handle.includes('e') ? -b.width / 2 : 0;
        const y = handle.includes('n') ? b.height / 2 : handle.includes('s') ? -b.height / 2 : 0;
        return {
          x: b.x + b.width / 2 + x * Math.cos(angle) - y * Math.sin(angle),
          y: b.y + b.height / 2 + x * Math.sin(angle) + y * Math.cos(angle),
        };
      };
      expect(anchor(after.bounds).x).toBeCloseTo(anchor(original.bounds).x, 0);
      expect(anchor(after.bounds).y).toBeCloseTo(anchor(original.bounds).y, 0);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect((await nativeArtifact(page)).draft.content).toEqual(initial);
    }
  }
  const grip = canvas.getByRole('button', { name: 'Resize e', exact: true });
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 40, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await nativeArtifact(page)).draft.content).toEqual(initial);
});
