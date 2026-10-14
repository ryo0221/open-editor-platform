import { test, expect } from './fixtures';
import { builtinTemplates, remapNative, type InputValue } from '@editor-platform/templates';
import { canonicalJson } from '@editor-platform/artifact-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
async function result(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export template result', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}
for (const definition of builtinTemplates.filter((d) => d.kind === 'whole')) {
  test(`TP-Q01/02/04/16 ${definition.templateId}: native sample and equal human/agent expansion`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    page.setDefaultTimeout(12000);
    await page.goto('/template-host.html');
    await page.getByLabel('Host template', { exact: true }).selectOption(definition.templateId);
    const human = page.getByRole('heading', { name: 'Human form', exact: true }).locator('..');
    const preview = page.getByRole('region', { name: 'Host prepared preview', exact: true });
    await human.getByRole('button', { name: 'Formから準備', exact: true }).click();
    await expect(preview).toBeVisible();
    if (['slide', 'whiteboard', 'design'].includes(definition.domain)) {
      const image = preview.getByRole('img', { name: 'テンプレートの実描画' });
      await expect
        .poll(() =>
          image.evaluate((img) => ({
            complete: (img as HTMLImageElement).complete,
            width: (img as HTMLImageElement).naturalWidth,
          })),
        )
        .toMatchObject({ complete: true });
      expect(await image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(
        0,
      );
    } else if (definition.domain === 'document') {
      await expect(preview.frameLocator('iframe').locator('body')).toContainText(
        String(definition.sample.title),
      );
    } else await expect(preview.getByRole('grid')).toBeVisible();
    await mkdir('docs/screenshots/issue-4/samples', { recursive: true });
    await preview.screenshot({
      path: `docs/screenshots/issue-4/samples/${definition.templateId}.png`,
    });
    if (definition.domain === 'slide') {
      const nextPage = preview.getByRole('button', { name: '次のページ', exact: true });
      let index = 2;
      while (await nextPage.isEnabled()) {
        await nextPage.click();
        await preview.getByRole('img').evaluate((img) => (img as HTMLImageElement).decode());
        await preview.screenshot({
          path: `docs/screenshots/issue-4/samples/${definition.templateId}-page-${index++}.png`,
        });
      }
    } else if (definition.domain === 'document') {
      const full = await page.context().newPage(),
        errors: string[] = [];
      full.on('pageerror', (e) => errors.push(e.message));
      full.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await full.setContent((await preview.locator('iframe').getAttribute('srcdoc'))!);
      await expect(full.locator('body')).toContainText(String(definition.sample.title));
      if (definition.sample.results) await expect(full.locator('table')).toBeVisible();
      await full.screenshot({
        path: `docs/screenshots/issue-4/samples/${definition.templateId}-full.png`,
        fullPage: true,
      });
      await full.close();
      expect(errors).toEqual([]);
    }
    const inputs = structuredClone(definition.sample);
    let path: string, next: string;
    if (definition.domain === 'whiteboard') {
      path = 'stage0';
      const lines = [...(inputs.stage0 as string[]), '追加の観察を記録'];
      inputs.stage0 = lines;
      next = lines.join('\n');
    } else if (definition.domain === 'data') {
      path = 'rows.0.label';
      const row = (inputs.rows as Record<string, InputValue>[])[0];
      next = String(row.label) + '（確認）';
      row.label = next;
    } else {
      path = 'title';
      next = String(inputs.title) + '・試行';
      inputs.title = next;
    }
    await human.locator(`[data-slot="${path}"]`).fill(next);
    await human.getByRole('button', { name: 'Formから準備', exact: true }).click();
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Hostに作成', exact: true }).click();
    await expect(preview).toHaveCount(0);
    const fromHuman = await result(page);
    const agentInputs = page.getByLabel('Agent inputs', { exact: true });
    // Export leaves the input above the viewport. Focus it by an actual click first:
    // fill() alone can race Chromium's deferred focus scroll with the prepare click.
    await agentInputs.click();
    await agentInputs.fill(JSON.stringify(inputs));
    await page.getByRole('button', { name: 'Agent APIから準備', exact: true }).click();
    await expect(preview).toBeVisible();
    await preview.getByRole('button', { name: 'Hostに作成', exact: true }).click();
    await expect(preview).toHaveCount(0);
    const fromAgent = await result(page);
    expect(fromAgent.id).not.toBe(fromHuman.id);
    expect(
      canonicalJson(remapNative(fromAgent.draft.content, new Map(), 'normalized').content),
    ).toEqual(canonicalJson(remapNative(fromHuman.draft.content, new Map(), 'normalized').content));
    expect(fromAgent.provenance.template.hash).toBe(definition.hash);
    expect(fromHuman.annotations).toBeUndefined();
    await mkdir('docs/exports/issue-4/native', { recursive: true });
    await writeFile(
      `docs/exports/issue-4/native/${definition.templateId}.json`,
      JSON.stringify(fromHuman, null, 2) + '\n',
    );
  });
}
