// Record actual normal production Playground operations; native candidates are authored fixtures.
/* global document */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
const baseURL = process.env.FICTION_MAP_DEMO_URL || 'http://127.0.0.1:4173';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseURL).hostname))
  throw Error('Use a local production preview.');
const root = path.resolve(process.env.FICTION_MAP_EXAMPLES_OUTPUT || 'work/fiction-map-examples');
await mkdir(root, { recursive: true });
const modulePath = path.join(root, 'scenarios.mjs');
await build({
  stdin: {
    contents:
      "export * from './scripts/fixtures/fiction-map-examples'; export { renderFictionMapSvg } from '@editor-platform/fiction-map/render';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: modulePath,
});
const {
  exampleIds,
  exampleBriefs,
  exampleStages,
  exampleContent,
  exampleArtifact,
  renderFictionMapSvg,
} = await import(pathToFileURL(modulePath).href);
const ids = process.argv.slice(2);
if (ids.some((id) => !exampleIds.includes(id))) throw Error('Unknown example');
const browser = await chromium.launch({
  headless: true,
  slowMo: 90,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
});
try {
  for (const id of ids.length ? ids : exampleIds) {
    const output = path.join(root, id),
      brief = exampleBriefs[id];
    await mkdir(output, { recursive: true });
    const artifact = exampleArtifact(id);
    await writeFile(path.join(output, 'initial-artifact.json'), JSON.stringify(artifact));
    for (const stage of exampleStages)
      await writeFile(
        path.join(output, `${stage}-content.json`),
        JSON.stringify(exampleContent(id, stage)),
      );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: output, size: { width: 1440, height: 900 } },
      acceptDownloads: true,
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const manifest = {
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTreeChanges: execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean),
      id,
      title: brief.title,
      status: 'FAIL',
      url: baseURL,
      browser: browser.version(),
      viewport: '1440x900',
      provenance:
        'Authored synthetic land-use/history briefs; external native candidates, explicitly previewed/applied in normal Editor. No GIS dataset, built-in generator, physical simulation or historical reconstruction.',
      steps: [],
    };
    const button = (name) => page.getByRole('button', { name, exact: true });
    async function caption(text, hold = 4500) {
      manifest.steps.push(text);
      await page.evaluate((text) => {
        let element = document.getElementById('map-demo-caption');
        if (!element) {
          element = document.createElement('div');
          element.id = 'map-demo-caption';
          Object.assign(element.style, {
            position: 'fixed',
            bottom: '18px',
            left: '240px',
            right: '24px',
            padding: '16px 22px',
            borderRadius: '10px',
            background: '#173d40f2',
            color: '#fff',
            font: '20px/1.5 sans-serif',
            zIndex: '99999',
            pointerEvents: 'none',
            whiteSpace: 'pre-line',
          });
          document.body.append(element);
        }
        element.textContent = text;
      }, text);
      await setTimeout(hold); // Readable presentation pause; never an acceptance timeout.
    }
    async function download(name, file) {
      const pending = page.waitForEvent('download');
      await button(name).click();
      await (await pending).saveAs(path.join(output, file));
      return readFile(path.join(output, file));
    }
    async function native(file) {
      await button('Export artifact').click();
      const result = JSON.parse(await download('Export JSON', file));
      await page.keyboard.press('Escape');
      return result;
    }
    async function save(count, reason) {
      await button('Save version').click();
      await page.getByLabel('Version reason', { exact: true }).fill(reason);
      await page
        .getByRole('dialog', { name: 'Save immutable version', exact: true })
        .getByRole('button', { name: 'この版を保存', exact: true })
        .click();
      await button('History and compare').click();
      await expect(
        page.getByRole('tab', { name: `History (${count})`, exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('status').first()).toHaveText('Saved locally');
    }
    async function cleanCanvas(file) {
      if (await page.getByLabel('Map details').isVisible())
        await button('Layers and inspector').click();
      if (await page.getByLabel('Artifact type', { exact: true }).isVisible())
        await button('Toggle library').click();
      await button('Fit map').click();
      await page
        .getByRole('application', { name: 'Fiction Map canvas' })
        .screenshot({ path: path.join(output, file) });
    }
    try {
      await page.goto(baseURL);
      await page
        .getByLabel('Import artifact', { exact: true })
        .setInputFiles(path.join(output, 'initial-artifact.json'));
      await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
      await caption(
        `${brief.title}\n${brief.brief}\n制作例：作者が用意した候補をEditorでプレビュー・適用します。`,
        7000,
      );
      await cleanCanvas('01-rough.png');
      await caption(
        '1｜まずはラフ。水・道・拠点の位置関係だけを確認します。\nこの段階で保存し、後から戻れるようにします。',
      );
      await save(1, '位置関係のラフ');
      const rough = await native('01-rough-artifact.json');
      await button('Layers and inspector').click();
      const refinement = page.locator('.fm-native-input');
      await refinement.locator('summary').click();
      for (const stage of ['structure', 'detailed']) {
        await refinement
          .getByLabel('Refinement native JSON')
          .setInputFiles(path.join(output, `${stage}-content.json`));
        const preview = refinement.getByAltText('Map refinement preview');
        await expect(preview).toBeVisible();
        await preview.scrollIntoViewIfNeeded();
        await expect(preview).toBeInViewport({ ratio: 1 });
        await page.screenshot({ path: path.join(output, `${stage}-preview.png`) });
        await caption(
          `${stage === 'structure' ? '2｜土地利用と道の骨格' : '3｜暮らしが見える詳細'}\n${brief[stage === 'structure' ? 'structure' : 'detail']}\n候補を確認して「Apply map refinement」で明示適用。`,
          6500,
        );
        await refinement.getByRole('button', { name: 'Apply map refinement', exact: true }).click();
        const applied = await native(`${stage}-artifact.json`);
        assert.equal(applied.id, rough.id);
        assert.deepEqual(applied.versions, rough.versions);
        assert.deepEqual(applied.draft.content, exampleContent(id, stage));
        if (stage === 'structure') {
          await button('Undo').first().click();
          assert.deepEqual((await native('undo-artifact.json')).draft.content, rough.draft.content);
          await page
            .getByRole('application', { name: 'Fiction Map canvas' })
            .scrollIntoViewIfNeeded();
          await caption(
            '詳細化も1回のUndoでラフへ。\n同じ地図・同じ履歴のまま、配置を試し直せます。',
            3500,
          );
          await button('Redo').first().click();
          assert.deepEqual(
            (await native('redo-artifact.json')).draft.content,
            applied.draft.content,
          );
        }
        await refinement.locator('summary').click();
        await cleanCanvas(`${stage === 'structure' ? '02-structure' : '03-detailed'}.png`);
        await caption(
          stage === 'structure'
            ? `骨格を見直す：${brief.structure}`
            : `細部を重ねる：${brief.detail}`,
        );
        await button('Layers and inspector').click();
        if (stage === 'structure') await refinement.locator('summary').click();
      }
      await page
        .locator('.fm-features')
        .getByRole('button', { name: brief.landmark, exact: true })
        .click();
      await page.getByRole('application', { name: 'Fiction Map canvas' }).scrollIntoViewIfNeeded();
      await caption(
        `4｜最後は手で調整。${brief.edit}\n各地点・線・区画は、個別に選択して編集できます。`,
      );
      await page.getByLabel('Feature x', { exact: true }).fill(String(brief.position[0] + 20));
      await page.getByLabel('Feature y', { exact: true }).fill(String(brief.position[1] - 20));
      await button('Apply feature').click();
      const edited = await native('edited-artifact.json');
      assert.deepEqual(
        edited.draft.content.features.find((f) => f.id === brief.landmarkId).geometry.coordinates,
        [brief.position[0] + 20, brief.position[1] - 20],
      );
      await button('Undo').first().click();
      assert.deepEqual((await native('edit-undo.json')).draft.content, exampleContent(id));
      await button('Redo').first().click();
      assert.deepEqual((await native('edit-redo.json')).draft.content, edited.draft.content);
      await save(2, '土地利用・街路・建物を詳細化');
      const final = await native('final-artifact.json');
      assert.deepEqual(final.versions[0], rough.versions[0]);
      assert.deepEqual(final.versions[1].content, final.draft.content);
      await caption(
        '5｜詳細版を別の確定版として保存。\nラフの旧版を上書きせず、用途に合わせてSVG・PNGを書き出します。',
      );
      await page
        .getByLabel('Saved map version', { exact: true })
        .selectOption(final.versions[1].versionId);
      await page
        .getByLabel('Saved map view', { exact: true })
        .selectOption(JSON.stringify({ kind: 'named', id: 'overview' }));
      await page.getByLabel('Map output width', { exact: true }).fill('1400');
      await page.getByLabel('Map output height', { exact: true }).fill('910');
      const svg = await download('Export map SVG', 'final.svg');
      await download('Export map PNG', 'final.png');
      const additionalViews = final.draft.content.namedViews.filter(
        (view) => view.id !== 'overview',
      );
      for (const [index, view] of additionalViews.entries()) {
        await page
          .getByLabel('Saved map view', { exact: true })
          .selectOption(JSON.stringify({ kind: 'named', id: view.id }));
        await caption(
          `保存ビュー「${view.name}」からも出力。\n駅前など見せたい範囲を明示し、cameraの一時状態とは分けて保存します。`,
        );
        const savedSvg = await download('Export map SVG', `saved-view-${index + 1}.svg`);
        await download('Export map PNG', `saved-view-${index + 1}.png`);
        assert.equal(
          savedSvg.toString(),
          renderFictionMapSvg(final.versions[1].content, {
            width: 1400,
            height: 910,
            view: { kind: 'named', id: view.id },
          }).svg,
        );
      }
      await page
        .getByLabel('Saved map view', { exact: true })
        .selectOption(JSON.stringify({ kind: 'named', id: 'overview' }));
      await page
        .getByLabel('Saved map version', { exact: true })
        .selectOption(final.versions[0].versionId);
      const oldSvg = await download('Export map SVG', 'rough-saved.svg');
      const renderOptions = { width: 1400, height: 910, view: { kind: 'named', id: 'overview' } };
      assert.equal(
        svg.toString(),
        renderFictionMapSvg(final.versions[1].content, renderOptions).svg,
      );
      assert.equal(
        oldSvg.toString(),
        renderFictionMapSvg(rough.versions[0].content, renderOptions).svg,
      );
      assert.notEqual(svg.toString(), oldSvg.toString());
      assert.deepEqual((await native('after-output.json')).draft.content, final.draft.content);
      await page.reload();
      await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
      const reloaded = await native('reloaded-artifact.json');
      assert.deepEqual(reloaded.draft.content, final.draft.content);
      assert.deepEqual(reloaded.versions, final.versions);
      await cleanCanvas('04-final-editor.png');
      // A clearly titled closing card uses the downloaded saved-version SVG, never a screen mockup.
      await page.evaluate(
        ({ title, uri }) => {
          const card = document.createElement('div');
          card.id = 'map-demo-closing';
          Object.assign(card.style, {
            position: 'fixed',
            inset: '0',
            background: '#f3f0e7',
            zIndex: '99998',
            padding: '20px 38px',
            fontFamily: 'sans-serif',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          });
          const heading = document.createElement('h1');
          heading.textContent = `${title}｜保存した詳細版`;
          const img = document.createElement('img');
          img.src = uri;
          img.alt = title;
          img.style.maxWidth = '100%';
          img.style.height = '700px';
          card.append(heading, img);
          document.body.append(card);
        },
        { title: brief.title, uri: `data:image/svg+xml;base64,${svg.toString('base64')}` },
      );
      await caption(
        'ラフ → 土地利用・道 → 建物・植栽 → 手直し → 保存。\nこの地図をさらに編集し、物語や設定資料の保存版参照へ引き継げます。',
        7000,
      );
      await page.screenshot({ path: path.join(output, '05-closing.png') });
      assert.deepEqual(errors, []);
      manifest.versions = final.versions.map(({ versionId, contentHash }) => ({
        versionId,
        contentHash,
      }));
      manifest.status = 'PASS';
    } catch (error) {
      manifest.error = String(error);
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
      throw error;
    } finally {
      manifest.consoleErrors = errors;
      await context.close();
      await page.video().saveAs(path.join(output, `${id}.webm`));
      await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    process.stdout.write(`${id}: PASS (production UI, native/history/version/reopen, SVG/PNG)\n`);
  }
} finally {
  await browser.close();
}
