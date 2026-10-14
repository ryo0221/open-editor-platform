import { test, expect } from './fixtures';
import { downloadText } from './template-fixtures';
import { portableComposition, compositionImage } from '../fixtures/reuse/composition';
import { remapNative } from '@editor-platform/templates';
import type { DocumentContent } from '@editor-platform/document/model';
import { writeFile } from 'node:fs/promises';

test('R13/R14 empty independent Host imports nested asset/token composition and human/agent share generation, diagnostics and permission', async ({
  page,
  browserName,
}, info) => {
  test.setTimeout(150000);
  page.setDefaultTimeout(12000);
  const fixture = await portableComposition();
  expect(fixture.definition.dependencies).toHaveLength(2);
  expect(fixture.closure.definitions).toHaveLength(5);
  const exact = { exact: true };
  await page.goto('/template-host.html?empty-catalog=1');
  await page.evaluate(() => {
    document.addEventListener(
      'load',
      (event) => {
        if (event.target instanceof HTMLIFrameElement)
          event.target.dataset.testPreviewLoadedSource = event.target.srcdoc;
      },
      true,
    );
  });
  await expect(
    page.getByRole('combobox', { name: 'Host template', ...exact }).locator('option'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Galleryを開く', ...exact }).click();
  const gallery = page.getByRole('dialog', { name: 'テンプレートから作成', ...exact });
  await gallery.getByLabel('テンプレートpackを読み込む', exact).setInputFiles({
    name: 'composition.template.json',
    mimeType: 'application/json',
    buffer: Buffer.from(fixture.pack),
  });
  await expect(
    gallery.getByRole('button', { name: 'テンプレートを選択: 持ち運べる案件文書', ...exact }),
  ).toBeVisible();
  await gallery.getByRole('button', { name: 'Close テンプレートから作成', ...exact }).click();
  await expect(page.getByRole('combobox', { name: 'Host template', ...exact })).toHaveValue(
    fixture.template.templateId,
  );
  const form = page.getByRole('heading', { name: 'Human form', ...exact }).locator('..');
  await form.getByLabel('案件の本文', { exact: false }).fill('案件Bの日本語本文');
  await form.getByLabel('コピーの本文', { exact: false }).fill('案件ごとに独立した本文');
  const inputs = {
    ...fixture.template.sample,
    body: '案件Bの日本語本文',
    copyBody: '案件ごとに独立した本文',
  };
  await page.getByRole('button', { name: 'Formから準備', ...exact }).click();
  const preview = page.getByRole('region', { name: 'Host prepared preview', ...exact });
  await expect(preview.locator('iframe')).toHaveAttribute(
    'data-test-preview-loaded-source',
    /案件Bの日本語本文/,
  );
  if (browserName === 'webkit') {
    // WebKit blocks Playwright's injected frame script. Observe loading from
    // the parent and inspect the inert HTML; keep the real sandboxed screenshot.
    const html = await preview.locator('iframe').getAttribute('srcdoc');
    const rendered = await page.evaluate((source) => {
      const document = new DOMParser().parseFromString(source!, 'text/html');
      return {
        text: document.body.textContent,
        images: [...document.images].map((i) => i.getAttribute('src')),
      };
    }, html);
    expect(rendered.text).toContain(inputs.body);
    expect(rendered.images).toEqual([compositionImage, compositionImage, compositionImage]);
  } else {
    await expect(preview.frameLocator('iframe').locator('body')).toContainText(inputs.body);
    await expect(preview.frameLocator('iframe').getByRole('img')).toHaveCount(3);
    await expect
      .poll(() =>
        preview
          .frameLocator('iframe')
          .getByRole('img')
          .evaluateAll((images) =>
            images.every(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
  }
  await preview.screenshot({ path: info.outputPath('composition-independent-host.png') });
  await page.getByRole('checkbox', { name: 'Host read only', ...exact }).check();
  await expect(preview.getByRole('button', { name: 'Hostに作成', ...exact })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Host read only', ...exact }).uncheck();
  await preview.getByRole('button', { name: 'Hostに作成', ...exact }).click();
  await expect(preview).toHaveCount(0);
  const human = JSON.parse(await downloadText(page, 'Export template result'));
  const data = human.draft.content as DocumentContent;
  expect(data.reuse!.instances).toHaveLength(2);
  expect(data.reuse!.artifactMode).toBe('dark');
  expect(data.reuse!.instances[0].inputs[fixture.text]).toBe(inputs.body);
  expect(
    data.blocks.filter((b) => b.type === 'image').every((b) => b.src === compositionImage),
  ).toBe(true);
  expect(data.blocks.find((b) => b.text === inputs.body)?.style?.color).toBe('#99ccff');
  expect(Object.values(data.reuse!.instances[0].slots).flat()).toEqual(
    Object.values(data.reuse!.instances[1].parts),
  );
  const agent = page.getByRole('textbox', { name: 'Agent inputs', ...exact });
  await agent.click();
  await agent.fill(JSON.stringify({ ...inputs, body: 123 }));
  await page.getByRole('button', { name: 'Agent APIから準備', ...exact }).click();
  await expect(page.getByRole('alert').first()).toContainText('Agent inputs need correction');
  await expect(preview).toHaveCount(0);
  await agent.fill(JSON.stringify(inputs));
  await page.getByRole('button', { name: 'Agent APIから準備', ...exact }).click();
  await preview.getByRole('button', { name: 'Hostに作成', ...exact }).click();
  await expect(preview).toHaveCount(0);
  const fromAgent = JSON.parse(await downloadText(page, 'Export template result'));
  expect(fromAgent.id).not.toBe(human.id);
  expect(remapNative(fromAgent.draft.content, new Map(), 'normalized').content).toEqual(
    remapNative(data, new Map(), 'normalized').content,
  );
  for (const [name, value] of [
    ['composition.template.json', JSON.parse(fixture.pack)],
    ['human.artifact.json', human],
    ['agent.artifact.json', fromAgent],
  ] as const)
    await writeFile(info.outputPath(name), JSON.stringify(value, null, 2));
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Host template', ...exact })).toHaveValue(
    fixture.template.templateId,
  );
  await page.getByRole('button', { name: 'Galleryを開く', ...exact }).click();
  const bad = JSON.parse(fixture.pack);
  bad.reusable[0].definitions[0].hash = '0'.repeat(64);
  await gallery.getByLabel('テンプレートpackを読み込む', exact).setInputFiles({
    name: 'bad.template.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bad)),
  });
  await expect(gallery.getByRole('alert')).toBeVisible();
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 持ち運べる案件文書', ...exact })
    .click();
  const exported = JSON.parse(await downloadText(page, 'packを書き出す'));
  expect(exported.definitions[0].hash).toBe(fixture.template.hash);
  expect(exported.reusable[0].hash).toBe(JSON.parse(fixture.pack).reusable[0].hash);
});
