import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expect, create, nativeArtifact, save } from './fixtures';
import { independentDesignReuse } from './design-reuse-graphics-fixtures';
import {
  foreignVectorUpdateFixture,
  foreignVector,
} from '../fixtures/design-reuse/foreign-vector-update';
import { vectorUpdateFixture } from '../fixtures/design-reuse/post-258';
import { applyLocalTemplate, measureTemplateTextFit } from '@editor-platform/templates';
import { makeDesignElement, type DesignContent } from '@editor-platform/design/model';

export async function assertPost258(page: Page) {
  const f = await vectorUpdateFixture();
  const diff = await f.preview();
  const next = applyLocalTemplate(diff.prepared!, f.current) as DesignContent;
  const text = '確認';
  const runs = [{ text, style: { fontSize: 9 } }];
  const bounds = { x: 30, y: 0, width: 100, height: 40 };
  expect(measureTemplateTextFit({ text, runs, bounds, fontSize: 12, minFontSize: 10 }).fits).toBe(
    false,
  );
  next.elements.push({
    ...makeDesignElement('text'),
    id: 'small-run',
    text,
    runs,
    bounds,
    typography: { fontSize: 12 },
  });
  await independentDesignReuse(page, next);
  await expect(page.locator('svg path[d="M0 0L12 12"]')).toBeVisible();
  await expect(
    page.locator('svg tspan[font-size]').filter({ hasText: text }).first(),
  ).toHaveAttribute('font-size', '9');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Host export SVG', exact: true }).click();
  const svg = await readFile((await (await pending).path())!, 'utf8');
  expect(svg).toContain('M0 0L12 12');
  expect(svg).not.toContain('M20 6 9 17l-5-5');
  expect(svg).toContain('font-size="9"');
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(next);
  await expect(page.locator('svg path[d="M0 0L12 12"]')).toBeVisible();
}

export async function assertForeignVectorUpdate(
  page: Page,
  domain: 'slide' | 'whiteboard',
  change: 'change' | 'delete',
) {
  const f = await foreignVectorUpdateFixture(domain, change);
  expect(f.preview.conflicts).toEqual([]);
  const content = applyLocalTemplate(f.preview.prepared!, f.current);
  await page.goto('/');
  await create(page, domain);
  const record = await nativeArtifact(page);
  record.draft.content = content;
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'adopted-opaque-vector.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  const canvas = page.getByRole('application', {
    name: domain === 'slide' ? 'Slide canvas' : 'Whiteboard canvas',
    exact: true,
  });
  await expect(canvas).toBeVisible();
  await expect(canvas.locator('[data-vector-source]')).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(content);
  await save(page, 1);
  await page.reload();
  await expect(canvas).toBeVisible();
  const reopened = await nativeArtifact(page);
  expect(reopened.draft.content).toEqual(content);
  expect(reopened.versions).toHaveLength(1);
  expect(reopened.versions[0].content).toEqual(content);
  // Check the opaque field separately from the complete native record comparison.
  const parts =
    domain === 'slide' && 'slides' in reopened.draft.content
      ? reopened.draft.content.slides.flatMap((slide) => slide.objects)
      : 'nodes' in reopened.draft.content
        ? reopened.draft.content.nodes
        : [];
  expect(parts.find((part) => part.id === f.address)).toMatchObject({
    vector: foreignVector,
    stroke: '#445566',
  });
  await expect(canvas.locator('[data-vector-source]')).toHaveCount(0);
}
