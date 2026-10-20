import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import {
  playerInputLimitAnimation,
  playerPosterLimitAnimation,
} from '../fixtures/animation-poster';
import { animationContainerFixture } from '../fixtures/animation-containers';
import { test, expect, create, nativeArtifact } from './fixtures';
import type { Artifact } from '@editor-platform/artifact-core';
import type { AnimationContent2 } from '@editor-platform/animation-core/v2';
import type { Page } from '@playwright/test';
import type { SlideContent } from '@editor-platform/slide/model';

test.beforeAll(async () => {
  const directory = 'work/issue74-2d/react-export/owner-context';
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: ['tests/fixtures/animation-owner.tsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    outfile: directory + '/runtime.js',
  });
  await writeFile(
    directory + '/player-source.json',
    JSON.stringify(
      playerInputLimitAnimation(await readFile('tests/fixtures/office/images/quadrants.png')),
    ),
  );
  await writeFile(
    directory + '/player-poster.json',
    JSON.stringify(
      playerPosterLimitAnimation(await readFile('tests/fixtures/office/images/quadrants.png')),
    ),
  );
  await writeFile(
    directory + '/index.html',
    '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="runtime.css"></head><body><div id="root"></div><button id="mount">Mount inputs</button><button id="reject">Set oversized inputs</button><button id="seek">Seek inputs</button><button id="play">Play inputs</button><button id="pause">Pause inputs</button><button id="dispose">Dispose inputs</button><output id="status"></output><div id="stage" style="width:300px;height:200px"></div><script type="module" src="runtime.js"></script></body></html>',
  );
});

for (const action of ['Remove edited target', 'Move edited target', 'Focus other composition'])
  test(`stage selection recovers after ${action}`, async ({ page }, info) => {
    await page.goto('http://127.0.0.1:4192/owner-context/');
    await page.getByRole('button', { name: 'Mount editing Host', exact: true }).click();
    const host = page.locator('#editing-host');
    await host.locator('[data-layer-id="edit-text"] button').click();
    await host.getByRole('button', { name: 'Edit text on canvas', exact: true }).click();
    await expect(host.locator('.ProseMirror')).toBeFocused();
    // Remote content/focus changes must not first blur and close the native editor.
    await host
      .getByRole('button', { name: action, exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(host.locator('.ProseMirror')).toHaveCount(0);
    const shape = host.locator('.a2-stage svg rect[data-instance]').first();
    await expect(shape).toBeVisible();
    await shape.click();
    const id = action === 'Focus other composition' ? 'other-box' : 'edit-box';
    await expect(host.locator(`[data-layer-id="${id}"] button`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(host.getByLabel('Layer name', { exact: true })).toHaveValue('rect');
    await host
      .locator('.a2-stage')
      .screenshot({ path: info.outputPath('recovered-text-owner.png') });
  });

test('fractional PNG export includes the full scaled right and bottom frame edges', async ({
  page,
}, info) => {
  await page.goto('http://127.0.0.1:4192/owner-context/');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export fractional frame', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  await writeFile(info.outputPath('fractional-frame.png'), bytes);
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([101, 81]);
  const pixels = await page.evaluate(async (base64) => {
    const image = await createImageBitmap(
        await (await fetch('data:image/png;base64,' + base64)).blob(),
      ),
      canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    image.close();
    return [
      Array.from(context.getImageData(100, 40, 1, 1).data),
      Array.from(context.getImageData(50, 80, 1, 1).data),
    ];
  }, bytes.toString('base64'));
  expect(pixels[0][0]).toBeGreaterThan(200);
  expect(pixels[0][1]).toBeLessThan(80);
  expect(pixels[1][2]).toBeGreaterThan(200);
  expect(pixels[1][1]).toBeLessThan(80);
});

test('controlled React inputs retain the playhead, playing state and last usable frame on refusal', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:4192/owner-context/');
  await page.getByRole('button', { name: 'Mount controlled inputs', exact: true }).click();
  const stage = page.locator('#controlled-stage'),
    svg = stage.locator('svg'),
    tick = stage.getByLabel('Animation tick');
  await expect(tick).toBeEnabled();
  await tick.fill('120000');
  await stage.getByRole('button', { name: 'Play animation' }).click();
  await expect
    .poll(async () => Number(await svg.getAttribute('data-tick')))
    .toBeGreaterThan(120000);
  await page.getByRole('button', { name: 'Update controlled inputs', exact: true }).click();
  await expect(svg.locator('text')).toHaveText('B');
  await expect(stage.getByRole('button', { name: 'Pause animation' })).toBeEnabled();
  await expect
    .poll(async () => Number(await svg.getAttribute('data-tick')))
    .toBeGreaterThan(120000);
  await stage.getByRole('button', { name: 'Pause animation' }).click();
  const paused = await svg.getAttribute('data-tick');
  await page.getByRole('button', { name: 'Reject controlled inputs', exact: true }).click();
  await expect(stage.getByRole('alert')).toContainText('Animation SVG size limit');
  await expect(svg).toHaveAttribute('data-tick', paused!);
  await expect(svg.locator('text')).toHaveText('B');
  await expect(stage.getByRole('button', { name: 'Play animation' })).toBeEnabled();
  await page.getByRole('button', { name: 'Update controlled inputs', exact: true }).click();
  await expect(stage.getByRole('alert')).toHaveCount(0);
  await expect(svg).toHaveAttribute('data-tick', paused!);
  await stage.getByRole('button', { name: 'Play animation' }).click();
  await expect
    .poll(async () => Number(await svg.getAttribute('data-tick')))
    .toBeGreaterThan(Number(paused));
});

for (const initiallyRefused of [false, true])
  test(`controlled inputs arriving during ${initiallyRefused ? 'refused' : 'usable'} resource preparation are reconciled`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const decode = window.createImageBitmap;
      let first = true;
      window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        if (!first) return decode(...args);
        first = false;
        document.documentElement.dataset.inputImageWaiting = 'true';
        return new Promise<ImageBitmap>((resolve, reject) =>
          window.addEventListener(
            'release-input-image',
            () => decode(...args).then(resolve, reject),
            { once: true },
          ),
        );
      }) as typeof createImageBitmap;
    });
    await page.goto('http://127.0.0.1:4192/owner-context/');
    if (initiallyRefused)
      await page.getByRole('button', { name: 'Reject controlled inputs', exact: true }).click();
    await page.getByRole('button', { name: 'Mount controlled inputs', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-input-image-waiting', 'true');
    await page
      .getByRole('button', {
        name: initiallyRefused ? 'Update controlled inputs' : 'Reject controlled inputs',
        exact: true,
      })
      .click();
    await page.evaluate(() => window.dispatchEvent(new Event('release-input-image')));
    const stage = page.locator('#controlled-stage');
    await expect(stage.getByRole('button', { name: 'Play animation' })).toBeEnabled();
    await expect(stage.locator('svg text')).toHaveText(initiallyRefused ? 'B' : 'A');
    if (!initiallyRefused) {
      await expect(stage.getByRole('alert')).toContainText('Animation SVG size limit');
      await page.getByRole('button', { name: 'Update controlled inputs', exact: true }).click();
      await expect(stage.locator('svg text')).toHaveText('B');
    }
    await expect(stage.getByRole('alert')).toHaveCount(0);
  });

for (const trigger of ['automatic', 'manual'] as const)
  for (const reduced of [false, true])
    test(`registered Player honors ${trigger} playback with reduced motion ${reduced}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.goto('http://127.0.0.1:4192/owner-context/');
      await page.getByRole('button', { name: 'Mount registered ' + trigger, exact: true }).click();
      const stage = page.locator('#registered-stage'),
        svg = stage.locator('svg[data-tick]');
      await expect(svg).toBeVisible();
      if (trigger === 'automatic' && !reduced) {
        await expect
          .poll(async () => Number(await svg.getAttribute('data-tick')))
          .toBeGreaterThan(0);
        await stage.getByRole('button', { name: 'Pause animation', exact: true }).click();
      } else {
        await expect(
          stage.getByRole('button', { name: 'Play animation', exact: true }),
        ).toBeEnabled();
        await expect(svg).toHaveAttribute('data-tick', '0');
        await stage.getByRole('button', { name: 'Play animation', exact: true }).click();
        await expect
          .poll(async () => Number(await svg.getAttribute('data-tick')))
          .toBeGreaterThan(0);
        await stage.getByRole('button', { name: 'Pause animation', exact: true }).click();
      }
    });

test('ordinary layer insertion cannot cover locked artwork and unlock remains one native command', async ({
  page,
}) => {
  const { createAnimation2, createAnimationLayer2 } = await import(
      '@editor-platform/animation-core/v2'
    ),
    { createArtifact } = await import('@editor-platform/artifact-core');
  const content = createAnimation2(),
    c = content.compositions[0],
    box = createAnimationLayer2('rect', 'protected', c.duration);
  box.locked = true;
  c.layers = [box];
  await page.goto('/');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'locked-insertion.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify(createArtifact('animation', 'Protected insertion', content)),
    ),
  });
  await expect(page.locator('.a2-stage svg rect[data-instance]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await expect(
    page
      .getByLabel('Animation 2D editor', { exact: true })
      .getByRole('status')
      .filter({ hasText: /locked:/ }),
  ).toContainText('locked');
  expect((await native(page)).draft.content).toEqual(content);
  await page.locator('[data-layer-id="protected"] button').click();
  await page.getByRole('button', { name: 'Unlock layer', exact: true }).click();
  const unlocked = (await native(page)).draft.content;
  expect(unlocked.compositions[0].layers[0].locked).toBe(false);
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  expect((await native(page)).draft.content.compositions[0].layers).toHaveLength(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(unlocked);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(content);
});

test('React controls report refused seeks without an uncaught browser exception', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:4192/owner-context/');
  await page.getByRole('button', { name: 'Mount poster', exact: true }).click();
  const stage = page.locator('#poster-stage'),
    slider = stage.getByLabel('Animation tick');
  await expect(stage.locator('svg')).toHaveAttribute('data-tick', '480000');
  await slider.fill('0');
  await expect(stage.getByRole('alert')).toContainText('Animation SVG size limit');
  await expect(slider).toBeDisabled();
  await expect(stage.getByRole('button', { name: 'Play animation' })).toBeDisabled();
});

test('mounts the requested lightweight poster without first rendering oversized tick zero', async ({
  page,
}, info) => {
  await page.goto('http://127.0.0.1:4192/owner-context/');
  await page.getByRole('button', { name: 'Mount poster', exact: true }).click();
  const svg = page.locator('#poster-stage svg');
  await expect(svg).toHaveAttribute('data-tick', '480000');
  await expect(svg.locator('rect[data-instance]')).toHaveCount(1);
  await expect(svg.locator('rect[data-instance]')).toHaveAttribute('fill', '#229955');
  await expect(page.locator('#poster-stage').getByRole('alert')).toHaveCount(0);
  await page
    .locator('#poster-stage')
    .screenshot({ path: info.outputPath('lightweight-initial-poster.png') });
});

test('restores the editor playhead before drawing a changed source with oversized tick zero', async ({
  page,
}, info) => {
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const source = playerPosterLimitAnimation(
    await readFile('tests/fixtures/office/images/quadrants.png'),
  );
  source.compositions[0].layers = source.compositions[0].layers.filter(
    (layer) => !layer.id.startsWith('instance-') || Number(layer.id.slice(9)) < 40,
  );
  await page.goto('/');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'restored.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify(createArtifact('animation', 'Restored lightweight frame', source)),
    ),
  });
  await expect(page.locator('.a2-stage svg')).toHaveAttribute('data-tick', '0');
  await page.getByLabel('Animation playhead', { exact: true }).fill('480000');
  await expect(page.locator('.a2-stage svg')).toHaveAttribute('data-tick', '480000');
  for (let i = 0; i < 20; i++)
    await page.locator(`[data-layer-id="instance-${i}"] input[type="checkbox"]`).check();
  await page.getByRole('button', { name: 'Duplicate layers', exact: true }).click();
  const changed = (await native(page)).draft.content;
  expect(
    changed.compositions[0].layers.filter((layer) => layer.type === 'composition'),
  ).toHaveLength(60);
  const { animationSceneSvg2 } = await import('@editor-platform/animation-player/v2'),
    { evaluateAnimation2, prepareAnimation2 } = await import('@editor-platform/animation-core/v2');
  expect(() =>
    animationSceneSvg2(evaluateAnimation2(prepareAnimation2(changed), 'root', 0)),
  ).toThrow('Animation SVG size limit');
  await expect(page.locator('.a2-stage svg')).toHaveAttribute('data-tick', '480000');
  await expect(page.locator('.a2-stage svg rect[data-instance]')).toHaveAttribute(
    'fill',
    '#229955',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(source);
  await expect(page.locator('.a2-stage svg')).toHaveAttribute('data-tick', '480000');
  await page
    .locator('.a2-stage')
    .screenshot({ path: info.outputPath('restored-lightweight-frame.png') });
});

for (const kind of ['group', 'composition'] as const)
  test(`stage drag moves the selected ${kind} while retaining its painted children`, async ({
    page,
  }, info) => {
    const { createArtifact } = await import('@editor-platform/artifact-core');
    const source = animationContainerFixture(kind);
    await page.goto('/');
    await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
      name: 'container.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(createArtifact('animation', 'Container drag', source))),
    });
    const selected = page.locator('[data-layer-id="container"] button');
    await selected.click();
    const shape = page.locator('.a2-stage svg rect[data-instance]').first();
    await shape.scrollIntoViewIfNeeded();
    const box = (await shape.boundingBox())!,
      x = box.x + box.width / 2,
      y = box.y + box.height / 2,
      scale = await shape.evaluate((element) => element.closest('svg')!.getScreenCTM()!.a);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 20, { steps: 4 });
    await page.mouse.up();
    const moved = (await native(page)).draft.content,
      owner = moved.compositions[0].layers.find((l) => l.id === 'container')!;
    expect(owner.transform.x).toBeCloseTo(100 + 40 / scale, 4);
    expect(owner.transform.y).toBeCloseTo(60 + 20 / scale, 4);
    expect(moved.compositions.flatMap((c) => c.layers).find((l) => l.id === 'paint')).toEqual(
      source.compositions.flatMap((c) => c.layers).find((l) => l.id === 'paint'),
    );
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.a2-stage').screenshot({ path: info.outputPath('moved-container.png') });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(source);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(moved);
  });

test('Animation retains the existing Comments exclusion when switching from an open inspector', async ({
  page,
}) => {
  const { createArtifact } = await import('@editor-platform/artifact-core');
  await page.goto('http://127.0.0.1:4173');
  await create(page, 'document');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('complementary', { name: 'Comments inspector', exact: true }),
  ).toBeVisible();
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  const source = animationContainerFixture('composition');
  await input.setInputFiles({
    name: 'comments-exclusion.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify(createArtifact('animation', 'Animation without comments', source)),
    ),
  });
  await expect(page.getByLabel('Animation composition', { exact: true })).toHaveValue('root');
  await expect(
    page.getByRole('complementary', { name: 'Comments inspector', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Comments \(/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).draft.content).toEqual(source);
});

test('refused private inputs retain the mounted frame and remain playable', async ({
  page,
}, info) => {
  await page.goto('http://127.0.0.1:4192/owner-context/');
  await page.getByRole('button', { name: 'Mount inputs', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Ready');
  const svg = page.locator('#stage svg');
  await expect(svg).toHaveAttribute('data-tick', '0');
  await page.getByRole('button', { name: 'Set oversized inputs', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Animation SVG size limit');
  await expect(svg).toHaveAttribute('data-tick', '0');
  await expect(svg.locator('text')).toHaveText('A');
  await page.getByRole('button', { name: 'Seek inputs', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Seeked');
  await expect(svg).toHaveAttribute('data-tick', '24000');
  await page.getByRole('button', { name: 'Play inputs', exact: true }).click();
  await expect.poll(async () => Number(await svg.getAttribute('data-tick'))).toBeGreaterThan(24000);
  await page.getByRole('button', { name: 'Pause inputs', exact: true }).click();
  await page
    .locator('#stage')
    .screenshot({ path: info.outputPath('retained-player-after-input-refusal.png') });
  await page.getByRole('button', { name: 'Dispose inputs', exact: true }).click();
  await expect(svg).toHaveCount(0);
});

for (const targetReduces of [true, false])
  test(`portal autoplay uses owner preference (${targetReduces ? 'reduce' : 'allow'})`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: targetReduces ? 'no-preference' : 'reduce' });
    await page.goto('http://127.0.0.1:4192/owner-context/');
    const owner = page.frameLocator('iframe');
    await expect(page.locator('iframe')).toBeVisible();
    await page.locator('iframe').evaluate((frame, reduces) => {
      const win = (frame as HTMLIFrameElement).contentWindow!,
        original = win.matchMedia.bind(win);
      win.matchMedia = (query) => {
        const media = original(query);
        if (query === '(prefers-reduced-motion: reduce)')
          Object.defineProperty(media, 'matches', { value: reduces });
        return media;
      };
    }, targetReduces);
    await page.getByRole('button', { name: 'Mount portal', exact: true }).click();
    const svg = owner.locator('svg');
    await expect(svg).toBeVisible();
    if (targetReduces) {
      await expect(
        owner.getByRole('button', { name: 'Play animation', exact: true }),
      ).toBeEnabled();
      await owner
        .locator('body')
        .evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      await expect(svg).toHaveAttribute('data-tick', '0');
      await owner.getByRole('button', { name: 'Play animation', exact: true }).click();
    }
    await expect.poll(async () => Number(await svg.getAttribute('data-tick'))).toBeGreaterThan(0);
    await owner.getByRole('button', { name: 'Pause animation', exact: true }).click();
    await page.locator('iframe').screenshot({ path: info.outputPath('owner-document-player.png') });
    await page.getByRole('button', { name: 'Unmount portal', exact: true }).click();
    await expect(svg).toHaveCount(0);
  });
function pngAnimationMetadata(bytes: Buffer) {
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset),
      data = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      bytes.toString('ascii', offset + 4, offset + 8) === 'iTXt' &&
      data.subarray(0, 21).toString() === 'Animation provenance\0'
    )
      return JSON.parse(data.subarray(25).toString('utf8'));
    offset += length + 12;
  }
  throw Error('Missing Animation provenance iTXt');
}
async function native(page: Page): Promise<Artifact<AnimationContent2>> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Native JSON', exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
}
test('unused malformed resources do not block selected playback or static SVG', async ({
  page,
}, info) => {
  const { createAnimation2, createAnimationLayer2, hashAnimationBytes2, encodeAnimationBase64 } =
    await import('@editor-platform/animation-core/v2');
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const source = createAnimation2(),
    root = source.compositions[0],
    bytes = (await readFile('tests/fixtures/office/images/quadrants.png')).subarray(0, 33);
  source.assets = [
    {
      id: 'broken',
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'image/png',
      base64: encodeAnimationBase64(bytes),
      attribution: 'Header only',
      license: 'Fixture',
    },
  ];
  root.layers = [createAnimationLayer2('rect', 'box', root.duration)];
  source.compositions.push({
    ...structuredClone(root),
    id: 'other',
    layers: [
      {
        ...createAnimationLayer2('group', 'image', root.duration),
        type: 'image',
        width: 100,
        height: 100,
        assetId: 'broken',
      },
    ],
  });
  await page.goto('/');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'unused.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('animation', 'Unused resource', source))),
  });
  await expect(page.locator('svg rect[data-instance]')).toBeVisible();
  await page.getByRole('button', { name: 'Export static frame…', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Confirm SVG export', exact: true }).click();
  expect(await readFile((await (await pending).path())!, 'utf8')).toContain('<rect');
  expect((await native(page)).draft.content).toEqual(source);
  const stage = page.locator('svg').filter({ has: page.locator('rect[data-instance]') });
  await stage.scrollIntoViewIfNeeded();
  await stage.screenshot({ path: info.outputPath('unused-resource-playback.png') });
});

test('deleting uploaded images releases bytes and native Undo restores ownership', async ({
  page,
}) => {
  await page.goto('/');
  const png = await readFile('tests/fixtures/office/images/quadrants.png');
  for (let i = 0; i < 3; i++) {
    const bytes = Buffer.alloc(1536 * 1024);
    png.copy(bytes);
    bytes[bytes.length - 1] = i;
    await page
      .getByLabel('Add Animation image', { exact: true })
      .setInputFiles({ name: `image-${i}.png`, mimeType: 'image/png', buffer: bytes });
    const added = (await native(page)).draft.content;
    expect(added.assets).toHaveLength(1);
    const image = added.compositions[0].layers.find((l) => l.type === 'image')!;
    await page.locator(`[data-layer-id="${image.id}"] button`).click();
    await page.getByRole('button', { name: 'Delete layers…', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm layer deletion', exact: true }).click();
    expect((await native(page)).draft.content.assets).toHaveLength(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(added);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await native(page)).draft.content.assets).toHaveLength(0);
  }
});

test('group paint-order controls move the complete subtree with one native Undo', async ({
  page,
}, info) => {
  const { createAnimation2, createAnimationLayer2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const source = createAnimation2(),
    c = source.compositions[0],
    group = createAnimationLayer2('group', 'group', c.duration),
    one = createAnimationLayer2('rect', 'one', c.duration),
    two = createAnimationLayer2('rect', 'two', c.duration),
    other = createAnimationLayer2('rect', 'other', c.duration),
    mask = createAnimationLayer2('rect', 'mask', c.duration),
    siblingMask = createAnimationLayer2('rect', 'sibling-mask', c.duration),
    front = createAnimationLayer2('rect', 'front', c.duration);
  one.parentId = two.parentId = group.id;
  mask.maskOnly = true;
  siblingMask.maskOnly = true;
  mask.parentId = group.id;
  group.transform.x = group.transform.y = 0;
  if (one.type !== 'rect' || two.type !== 'rect' || other.type !== 'rect') throw Error();
  one.fill = '#ef4444';
  two.fill = '#22c55e';
  two.width = 80;
  other.fill = '#3b82f6';
  c.layers = [mask, other, one, two, siblingMask, front, group];
  await page.goto('/');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'group.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('animation', 'Group paint order', source))),
  });
  const order = () =>
    page
      .locator('svg rect[data-instance]')
      .evaluateAll((nodes) =>
        nodes.map((n) => JSON.parse(n.getAttribute('data-instance')!).at(-1)),
      );
  await expect.poll(order).toEqual(['other', 'one', 'two', 'front']);
  await page.locator('[data-layer-id="group"] button').click();
  await page.getByRole('button', { name: 'Move forward', exact: true }).click();
  await expect.poll(order).toEqual(['other', 'front', 'one', 'two']);
  await page
    .locator('svg')
    .filter({ has: page.locator('rect[data-instance]') })
    .screenshot({ path: info.outputPath('group-paint-order.png') });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(source);
});

test('repeated image and font uploads reuse only matching resources and notices', async ({
  page,
}) => {
  await page.goto('/');
  const bytes = Buffer.alloc(1536 * 1024);
  (await readFile('tests/fixtures/office/images/quadrants.png')).copy(bytes);
  for (let i = 0; i < 3; i++) {
    await page
      .getByLabel('Add Animation image', { exact: true })
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: bytes });
    const content = (await native(page)).draft.content;
    expect(content.assets).toHaveLength(1);
    expect(content.compositions[0].layers.filter((l) => l.type === 'image')).toHaveLength(i + 1);
  }
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  const font = await readFile('work/issue74-2d/japanese-subset.otf');
  for (let i = 0; i < 2; i++) {
    await page
      .getByLabel('Add Animation font', { exact: true })
      .setInputFiles({ name: 'japanese.otf', mimeType: 'font/otf', buffer: font });
    expect((await native(page)).draft.content.assets).toHaveLength(2);
  }
  await page.getByText('Assets and public inputs', { exact: true }).click();
  await page.getByLabel('Asset attribution', { exact: true }).fill('Other notice');
  await page
    .getByLabel('Add Animation image', { exact: true })
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: bytes });
  const distinct = (await native(page)).draft.content.assets;
  expect(distinct).toHaveLength(3);
  expect(distinct.at(-1)?.attribution).toBe('Other notice');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content.assets).toHaveLength(2);
});

test('locked tracks disable easing without creating pending drafts', async ({ page }) => {
  const { createAnimation2, createAnimationLayer2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { createArtifact } = await import('@editor-platform/artifact-core');
  for (const target of ['box', 'group']) {
    const source = createAnimation2(),
      c = source.compositions[0];
    const group = createAnimationLayer2('group', 'group', c.duration),
      box = createAnimationLayer2('rect', 'box', c.duration);
    box.parentId = group.id;
    (target === 'box' ? box : group).locked = true;
    c.layers = [group, box];
    c.tracks = [
      {
        id: 'position',
        layerId: box.id,
        property: 'x',
        keys: [
          {
            id: 'key',
            tick: 0,
            value: 80,
            easing: { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
          },
        ],
      },
    ];
    await page.goto('/');
    await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
      name: 'locked.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(createArtifact('animation', 'Locked curve', source))),
    });
    await page.getByRole('button', { name: 'x key key', exact: true }).click();
    await expect(page.getByLabel('Key value', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Easing', { exact: true })).toBeDisabled();
    for (const axis of ['x1', 'y1', 'x2', 'y2'])
      await expect(page.getByLabel(`Bezier ${axis}`, { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel inputs', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(source);
    await expect(page.getByLabel('Saved versions', { exact: true })).toHaveText('1');
  }
});

test('stage drags preserve input-controlled positions and native history', async ({
  page,
}, info) => {
  const { createAnimation2, createAnimationLayer2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { createArtifact } = await import('@editor-platform/artifact-core');
  for (const property of ['x', 'y'] as const) {
    const source = createAnimation2(),
      c = source.compositions[0];
    c.layers = [createAnimationLayer2('rect', 'box', c.duration)];
    source.publicInputs = [
      {
        id: 'position',
        name: 'Position',
        kind: 'number',
        default: 180,
        min: 0,
        max: 1000,
        target: { compositionId: c.id, layerId: 'box', property },
      },
    ];
    await page.goto('/');
    await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
      name: 'bound.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify(createArtifact('animation', 'Controlled position', source)),
      ),
    });
    await page.locator('[data-layer-id="box"] button').click();
    await page.getByLabel('Width', { exact: true }).fill('160');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    const before = (await native(page)).draft.content;
    const edited = before.compositions[0].layers[0];
    expect(edited.type === 'rect' && edited.width).toBe(160);
    const shape = page.locator('.a2-stage svg rect[data-instance]').first();
    await shape.scrollIntoViewIfNeeded();
    const bounds = (await shape.boundingBox())!;
    const x = bounds.x + bounds.width / 2,
      y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + 20, { steps: 4 });
    await page.mouse.up();
    expect((await native(page)).draft.content).toEqual(before);
    await expect(page.getByLabel(`Base ${property}`, { exact: true })).toBeDisabled();
    if (property === 'y')
      await page.screenshot({
        path: info.outputPath('controlled-position-refusal.png'),
        fullPage: true,
      });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(source);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(before);
  }
});

test('work area resets after duration shrinks and does not return through native Undo', async ({
  page,
}) => {
  await page.goto('/');
  const start = page.getByLabel('Work area start (frame)', { exact: true }),
    end = page.getByLabel('Work area end (frame)', { exact: true }),
    duration = page.getByLabel('Composition duration (frames)', { exact: true });
  await start.fill('20');
  await start.press('Enter');
  await end.fill('100');
  await end.press('Enter');
  await duration.fill('60');
  await duration.press('Enter');
  await expect(start).toHaveValue('0');
  await expect(end).toHaveValue('60');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(duration).toHaveValue('120');
  await expect(start).toHaveValue('0');
  await expect(end).toHaveValue('120');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(end).toHaveValue('60');
  await start.fill('10');
  await start.press('Enter');
  await expect(end).toHaveValue('60');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByLabel('Animation playhead', { exact: true })).toHaveValue('480000');
  await expect(start).toHaveValue('10');
});
test('deleting exact instances releases their last provider and native Undo restores it', async ({
  page,
}) => {
  const {
    createAnimation2,
    createAnimationLayer2,
    createPlayableAnimationEmbed,
    insertExactAnimation,
  } = await import('@editor-platform/animation-core/v2');
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const { reuseHash } = await import('@editor-platform/reuse-core');
  const source = createAnimation2();
  source.compositions[0].layers = [createAnimationLayer2('rect', 'source-box', 960000)];
  const embed = createPlayableAnimationEmbed(
    { artifactId: 'saved', versionId: 'v1', compositionId: 'root', contentHash: reuseHash(source) },
    source,
    'Saved',
  );
  if (embed.format !== 'animation-embed-2') throw Error();
  let content = createAnimation2();
  for (const id of ['first', 'second'])
    content = insertExactAnimation(content, 'root', embed, id, { canEdit: () => true }).apply(
      content,
    );
  await page.goto('/');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'exact.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify(createArtifact('animation', 'Exact source deletion', content)),
    ),
  });
  await expect(page.locator('[data-layer-id="first"] button')).toBeVisible();
  for (const [id, count] of [
    ['first', 1],
    ['second', 0],
  ] as const) {
    await page.locator(`[data-layer-id="${id}"] button`).click();
    await page.getByRole('button', { name: 'Delete layers…', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm layer deletion', exact: true }).click();
    expect((await native(page)).draft.content.sources).toHaveLength(count);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content.sources).toHaveLength(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(content);
});

test('Slide refuses adoption when a retained consumer input changes kind', async ({ page }) => {
  const { createAnimation2, createAnimationLayer2, createPlayableAnimationEmbed } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { createArtifact, commitVersion } = await import('@editor-platform/artifact-core');
  const { createDeck, placeSlideAnimation } = await import('@editor-platform/slide/model');
  const old = createAnimation2();
  old.compositions[0].layers = [createAnimationLayer2('text', 'caption', 960000)];
  old.publicInputs = [
    {
      id: 'caption-input',
      name: 'Caption',
      kind: 'color',
      default: '#ff0000',
      min: 0,
      max: 0,
      target: { compositionId: 'root', layerId: 'caption', property: 'fill' },
    },
  ];
  for (const id of ['child', 'other']) {
    old.compositions.push({
      ...structuredClone(old.compositions[0]),
      id,
      layers: [createAnimationLayer2('text', `${id}-caption`, 960000)],
    });
    old.publicInputs.push({
      id: `${id}-input`,
      name: id,
      kind: 'text',
      default: 'Default',
      min: 0,
      max: 0,
      target: { compositionId: id, layerId: `${id}-caption`, property: 'text' },
    });
  }
  old.compositions[0].layers.push({
    ...createAnimationLayer2('group', 'child-instance', 960000),
    type: 'composition',
    source: { type: 'local', compositionId: 'child' },
    time: { sourceIn: 0, sourceOut: 960000, rate: { numerator: 1, denominator: 1 }, after: 'hold' },
  });
  const original = await commitVersion(
    createArtifact('animation', 'Typed source', old),
    'test',
    'Color',
  );
  const next = structuredClone(old);
  next.publicInputs[0].kind = 'text';
  next.publicInputs[0].target.property = 'text';
  const record = await commitVersion(
    { ...original, draft: { ...original.draft, content: next } },
    'test',
    'Text',
  );
  const embed = createPlayableAnimationEmbed(
    {
      artifactId: record.id,
      versionId: record.versions[0].versionId,
      compositionId: 'root',
      contentHash: record.versions[0].contentHash,
    },
    old,
    'Typed source',
  );
  if (embed.format !== 'animation-embed-2') throw Error();
  const deck = createDeck();
  deck.slides[0].objects = [];
  const slide = createArtifact(
    'slide',
    'Typed consumer',
    placeSlideAnimation(
      deck.slides[0].id,
      { ...embed, inputs: [{ inputId: 'caption-input', value: '#ff0000' }] },
      'instance',
    ).apply(deck),
  );
  await page.goto('http://127.0.0.1:4173');
  for (const artifact of [record, slide]) {
    const field = page.getByLabel('Import artifact', { exact: true });
    if (!(await field.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await field.setInputFiles({
      name: 'source.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(artifact)),
    });
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(artifact.name);
  }
  await page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .getByRole('button', { name: 'animation object 1', exact: true })
    .click();
  if (!(await page.getByRole('button', { name: '保存した別の版を選ぶ', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
  await expect(page.getByLabel('Animation input: other', { exact: true })).toHaveCount(0);
  const childInput = page.getByLabel('Animation input: child', { exact: true });
  await childInput.fill('Consumer child');
  await childInput.press('Enter');
  const before = await nativeArtifact(page);
  const consumer = (before.draft.content as SlideContent).slides[0].objects[0].animation!;
  expect(consumer.format === 'animation-embed-2' && consumer.inputs).toEqual([
    { inputId: 'caption-input', value: '#ff0000' },
    { inputId: 'child-input', value: 'Consumer child' },
  ]);
  await page.getByRole('button', { name: '保存した別の版を選ぶ', exact: true }).click();
  await page
    .getByLabel('保存した Animation', { exact: true })
    .selectOption({ label: 'Typed source / 版 2 / root' });
  await expect(page.getByRole('alert')).toContainText('input-adoption-conflict');
  await expect(page.getByRole('button', { name: 'この版を採用', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
});

test('public input property follows the selected layer capability', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await page.getByText('Assets and public inputs', { exact: true }).click();
  for (const property of ['text', 'fill']) {
    if (property === 'fill')
      await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
    await page.getByLabel('Public input property', { exact: true }).selectOption(property);
    await page.getByRole('button', { name: 'Add group', exact: true }).click();
    await expect(page.getByLabel('Public input property', { exact: true })).toHaveValue('opacity');
    await page.getByRole('button', { name: 'Add public input', exact: true }).click();
    expect((await native(page)).draft.content.publicInputs.at(-1)?.target.property).toBe('opacity');
  }
});

test('duration retains its target buffer when a peer unnests the edited composition', async ({
  page,
  browser,
}, info) => {
  const { createAnimation2, createAnimationLayer2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const content = createAnimation2(),
    root = content.compositions[0];
  const child = {
    ...structuredClone(root),
    id: 'child',
    name: 'Child',
    layers: [createAnimationLayer2('rect', 'child-box', root.duration)],
  };
  const base = createAnimationLayer2('group', 'instance', root.duration);
  base.transform.x = base.transform.y = 0;
  root.layers = [
    {
      ...base,
      type: 'composition',
      source: { type: 'local', compositionId: 'child' },
      time: {
        sourceIn: 0,
        sourceOut: root.duration,
        rate: { numerator: 1, denominator: 1 },
        after: 'hold',
      },
    },
  ];
  content.compositions.push(child);
  await page.goto('http://127.0.0.1:4173');
  const field = page.getByLabel('Import artifact', { exact: true });
  if (!(await field.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await field.setInputFiles({
    name: 'duration-source.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('animation', 'Duration source', content))),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Duration source');
  const closeLibrary = page.getByRole('button', { name: 'Close library panel', exact: true });
  if (await closeLibrary.isVisible()) await closeLibrary.click();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peerUrl = await page
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await page.keyboard.press('Escape');
  const context = await browser.newContext({
      viewport: page.viewportSize()!,
      isMobile: info.project.name === 'mobile',
      hasTouch: info.project.name === 'mobile',
    }),
    peer = await context.newPage(),
    errors: string[] = [];
  peer.on('pageerror', (error) => errors.push(error.message));
  peer.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    await peer.goto(new URL(peerUrl!, page.url()).href);
    await expect(peer.locator('.save-status')).toContainText('Shared · confirmed');
    await page.getByLabel('Animation composition', { exact: true }).selectOption('child');
    const duration = page.getByLabel('Composition duration (frames)', { exact: true });
    await duration.fill('180');
    await peer.locator('[data-layer-id="instance"] button').click();
    await peer.getByRole('button', { name: 'Unnest layer', exact: true }).click();
    await expect(page.getByLabel('Animation composition', { exact: true })).toHaveValue('root');
    await expect(duration).toHaveValue('180');
    await duration.press('Enter');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Composition changed' }).first(),
    ).toBeVisible();
    await duration.press('Escape');
    await expect(duration).toHaveValue('120');
    const current = (await nativeArtifact(page)).draft.content as AnimationContent2;
    expect(current.compositions).toHaveLength(1);
    expect(current.compositions[0].duration).toBe(960000);
    expect(current.compositions[0].layers.map((layer) => layer.id)).toEqual(['child-box']);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('duration respects other pending inputs while retaining its own editing and native Undo', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const duration = page.getByLabel('Composition duration (frames)', { exact: true }),
    y = page.getByLabel('Base y', { exact: true });
  const before = (await native(page)).draft.content;
  await y.fill('300');
  await expect(duration).toBeDisabled();
  await expect(y).toHaveValue('300');
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  await expect(duration).toBeEnabled();
  await duration.fill('180');
  await expect(duration).toBeEnabled();
  await duration.press('Enter');
  expect((await native(page)).draft.content.compositions[0].duration).toBe(1440000);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(before);
  await expect(duration).toHaveValue('120');
  await y.dispatchEvent('compositionstart');
  await expect(duration).toBeDisabled();
  await y.dispatchEvent('compositionend');
  await expect(duration).toBeEnabled();
  await page.getByText('Assets and public inputs', { exact: true }).click();
  await page.evaluate(() => {
    const state = window as typeof window & {
      releaseAnimationAsset?: () => void;
      animationAssetHeld?: boolean;
    };
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'held.png') return original.call(this);
      state.animationAssetHeld = true;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        state.releaseAnimationAsset = () => {
          void original.call(this).then(resolve, reject);
        };
      });
    };
  });
  await page.getByLabel('Add Animation image', { exact: true }).setInputFiles({
    name: 'held.png',
    mimeType: 'image/png',
    buffer: await readFile('tests/fixtures/office/images/quadrants.png'),
  });
  await page.waitForFunction(
    () => (window as typeof window & { animationAssetHeld?: boolean }).animationAssetHeld,
  );
  await expect(duration).toBeDisabled();
  await page.evaluate(() =>
    (window as typeof window & { releaseAnimationAsset(): void }).releaseAnimationAsset(),
  );
  await expect(page.locator('.a2-stage svg image')).toHaveCount(1);
  await expect(duration).toBeEnabled();
});
for (const direction of ['source', 'referrer']) {
  test(`local ${direction} lock protection preserves pending input and unrelated native Undo`, async ({
    page,
  }) => {
    const { createAnimation2, createAnimationLayer2 } = await import(
      '@editor-platform/animation-core/v2'
    );
    const { createArtifact } = await import('@editor-platform/artifact-core');
    const content = createAnimation2(),
      root = content.compositions[0];
    const child = {
        ...structuredClone(root),
        id: 'child',
        name: 'Child',
        layers: [createAnimationLayer2('rect', 'child-box', root.duration)],
      },
      unrelated = {
        ...structuredClone(root),
        id: 'unrelated',
        name: 'Unrelated',
        layers: [createAnimationLayer2('rect', 'other-box', root.duration)],
      };
    root.layers = [
      {
        ...createAnimationLayer2('group', 'instance', root.duration),
        type: 'composition',
        locked: direction === 'source',
        source: { type: 'local', compositionId: 'child' },
        time: {
          sourceIn: 0,
          sourceOut: root.duration,
          rate: { numerator: 1, denominator: 1 },
          after: 'hold',
        },
      },
    ];
    child.layers[0].locked = direction === 'referrer';
    content.compositions.push(child, unrelated);
    await page.goto('/');
    await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
      name: 'locked-source.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(createArtifact('animation', 'Locked source', content))),
    });
    await page
      .getByLabel('Animation composition', { exact: true })
      .selectOption(direction === 'source' ? 'child' : 'root');
    await page
      .locator(`[data-layer-id="${direction === 'source' ? 'child-box' : 'instance'}"] button`)
      .click();
    await page.getByLabel('Base y', { exact: true }).fill('300');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('locked');
    await expect(page.getByLabel('Base y', { exact: true })).toHaveValue('300');
    await page.screenshot({
      path: test.info().outputPath('locked-composition-source.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(content);
    await page.getByLabel('Animation composition', { exact: true }).selectOption('unrelated');
    await page.locator('[data-layer-id="other-box"] button').click();
    await page.getByLabel('Base y', { exact: true }).fill('300');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    expect((await native(page)).draft.content.compositions[2].layers[0].transform.y).toBe(300);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await native(page)).draft.content).toEqual(content);
  });
}

test('adding group and composition keys preserves the evaluated child poses', async ({ page }) => {
  const { animation2DFixture } = await import('../fixtures/animation-2d');
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const content = animation2DFixture(
    await readFile('work/issue74-2d/japanese-subset.otf'),
    await readFile('tests/fixtures/office/images/quadrants.png'),
    'Fixture license',
  );
  for (const layerId of ['group', 'nested'])
    content.compositions[0].tracks.push({
      id: layerId + '-position',
      layerId,
      property: 'x',
      keys: [
        { id: layerId + '-start', tick: 0, value: 100, easing: { type: 'linear' } },
        { id: layerId + '-end', tick: 480000, value: 300, easing: { type: 'hold' } },
      ],
    });
  await page.goto('/');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'container-keys.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('animation', 'Container keys', content))),
  });
  await page.getByLabel('Animation playhead', { exact: true }).fill('240000');
  const transforms = () =>
    page
      .locator('.a2-stage svg [data-instance]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('transform')));
  await expect(page.locator('.a2-stage svg text')).toHaveText('日本語アニメーション');
  const before = await transforms();
  for (const layerId of ['group', 'nested']) {
    await page.locator(`[data-layer-id="${layerId}"] button`).click();
    await page.getByLabel('Animated property', { exact: true }).selectOption('x');
    await page.getByRole('button', { name: 'Add key at playhead', exact: true }).click();
    const track = (await native(page)).draft.content.compositions[0].tracks.find(
      (t) => t.id === layerId + '-position',
    )!;
    expect(track.keys.find((key) => key.tick === 240000)?.value).toBe(200);
    await expect(page.getByLabel('Animation playhead', { exact: true })).toHaveValue('240000');
    await expect(page.locator('.a2-stage svg')).toHaveAttribute('data-tick', '240000');
    expect(await transforms()).toEqual(before);
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.a2-stage svg')).toHaveAttribute('data-tick', '240000');
  expect(await transforms()).toEqual(before);
});

test('a short Slide animation container contains the complete Player viewport', async ({
  page,
}, info) => {
  const { createAnimation2, createAnimationLayer2, createPlayableAnimationEmbed } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { createArtifact } = await import('@editor-platform/artifact-core');
  const { reuseHash } = await import('@editor-platform/reuse-core');
  const { createDeck, placeSlideAnimation, updateObject } = await import(
    '@editor-platform/slide/model'
  );
  const content = createAnimation2();
  content.compositions[0].layers = [createAnimationLayer2('rect', 'box', 960000)];
  const embed = createPlayableAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'saved',
      contentHash: reuseHash(content),
      compositionId: 'root',
    },
    content,
    'Short animation',
  );
  const deck = createDeck(),
    slide = deck.slides[0];
  slide.objects = [];
  const placed = placeSlideAnimation(slide.id, embed, 'small-animation').apply(deck);
  const resized = updateObject(slide.id, 'small-animation', {
    bounds: { x: 100, y: 100, width: 320, height: 60 },
  }).apply(placed);
  await page.goto('http://127.0.0.1:4173');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'short.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('slide', 'Short embedded player', resized))),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(
    'Short embedded player',
  );
  const present = page.getByRole('button', { name: 'Present', exact: true });
  if (!(await present.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await present.click();
  const dialog = page.getByRole('dialog', { name: 'Slide presentation', exact: true }),
    player = dialog.getByRole('region', { name: 'Animation: Short animation', exact: true });
  await expect(player.locator('svg')).toBeVisible();
  const dimensions = await player.evaluate((node) => {
    const container = node.closest('foreignObject')!.getBoundingClientRect(),
      svg = node.querySelector('svg')!.getBoundingClientRect();
    return {
      container: container.height,
      player: node.getBoundingClientRect().height,
      svg: svg.height,
    };
  });
  expect(dimensions.player).toBeCloseTo(dimensions.container, 0);
  expect(dimensions.svg).toBeCloseTo(dimensions.container, 0);
  await dialog.screenshot({ path: info.outputPath('short-slide-animation.png') });
});
test('current 2D editor creates Japanese text and assets, protects inputs and saves a portable version', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await expect(page.locator('.animation-player2 svg rect')).toHaveCount(1);
  await page.getByLabel('Base x', { exact: true }).fill('145');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  let record = await native(page);
  expect(record.draft.content.schemaVersion).toBe(2);
  expect(record.draft.content.compositions[0].layers[0].transform.x).toBe(145);
  await page.getByRole('button', { name: 'Add text', exact: true }).click();
  await page.getByText('Assets and public inputs', { exact: true }).click();
  await page.getByLabel('Asset attribution', { exact: true }).fill('Noto Sans CJK JP subset');
  await page.getByLabel('Asset license', { exact: true }).fill('OFL-1.1');
  await page
    .getByLabel('Add Animation font', { exact: true })
    .setInputFiles('work/issue74-2d/japanese-subset.otf');
  await expect(page.getByLabel('Text font', { exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Edit text on canvas', exact: true }).click();
  const text = page.locator('.ProseMirror');
  await text.press('ControlOrMeta+a');
  await page.keyboard.insertText('日本語アニメーション');
  await expect(text).toHaveText('日本語アニメーション');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.locator('.animation-player2 svg text')).toHaveText('日本語アニメーション');
  record = await native(page);
  expect(record.versions).toHaveLength(2);
  expect(record.draft.content.assets).toHaveLength(1);
  await writeFile(info.outputPath('saved-animation.json'), JSON.stringify(record));
  await page.getByRole('button', { name: 'View registered React Player', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Registered React Animation' }).locator('svg text'),
  ).toHaveText('日本語アニメーション');
  await page.getByRole('button', { name: 'Back to editor', exact: true }).click();
  for (const format of ['SVG', 'PNG']) {
    await page.getByRole('button', { name: 'Export static frame…', exact: true }).click();
    const confirmation = page.getByRole('group', {
      name: 'Static export confirmation',
      exact: true,
    });
    await expect(confirmation).toContainText('static frame');
    const pending = page.waitForEvent('download');
    await confirmation
      .getByRole('button', { name: `Confirm ${format} export`, exact: true })
      .click();
    const file = await pending,
      bytes = await readFile((await file.path())!);
    await writeFile(info.outputPath('frame.' + format.toLowerCase()), bytes);
    if (format === 'SVG') {
      expect(bytes.toString()).toContain('日本語アニメーション');
      expect(bytes.toString()).toContain('data:font/otf;base64,');
    } else {
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBe(640);
      expect(bytes.readUInt32BE(20)).toBe(360);
      expect(bytes.includes(Buffer.from('Animation provenance'))).toBe(true);
      expect(bytes.includes(Buffer.from('OFL-1.1'))).toBe(true);
      expect(bytes.includes(Buffer.from('Noto Sans CJK JP subset'))).toBe(true);
      const raster = await page.evaluate(
        async (data) => {
          const image = await createImageBitmap(
            new Blob([new Uint8Array(data)], { type: 'image/png' }),
          );
          const size = [image.width, image.height];
          image.close();
          return size;
        },
        [...bytes],
      );
      expect(raster).toEqual([640, 360]);
    }
  }

  const exportedDirectory = execFileSync(
    process.execPath,
    ['scripts/animation-react-export-host.mjs', info.outputPath('saved-animation.json')],
    { encoding: 'utf8' },
  ).trim();
  const exported = await page.context().newPage(),
    exportErrors: string[] = [];
  exported.on('pageerror', (error) => exportErrors.push(error.message));
  exported.on('console', (message) => {
    if (message.type() === 'error') exportErrors.push(message.text());
  });
  try {
    await exported.goto(
      'http://127.0.0.1:4192/' + path.basename(exportedDirectory) + '/index.html',
    );
    await expect(exported.locator('svg text')).toHaveText('日本語アニメーション');
    await expect
      .poll(async () => Number(await exported.locator('svg[data-tick]').getAttribute('data-tick')))
      .toBeGreaterThan(0);
    await exported.screenshot({
      path: info.outputPath('independent-react-export.png'),
      fullPage: true,
    });
    expect(exportErrors).toEqual([]);
  } finally {
    await exported.close();
  }
  await page.getByRole('button', { name: 'Add vector', exact: true }).click();
  await expect(page.locator('.animation-player2 svg path')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('2d-authoring.png'), fullPage: true });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.animation-player2 svg path')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.animation-player2 svg path')).toHaveCount(1);
  await page.getByLabel('Base x', { exact: true }).fill('invalid');
  const before = record.versions.length;
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(page.getByLabel('Base x', { exact: true })).toHaveValue('invalid');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel inputs', exact: true }).click();
  expect((await native(page)).versions.length).toBe(before);
});

test('ordinary shared Animation keeps peer geometry and private playback through actor Undo', async ({
  page,
  browser,
}, info) => {
  async function appendNativeText(target: Page, value: string) {
    const editor = target.locator('.ProseMirror');
    await expect(editor).toBeVisible();
    await editor.focus();
    await editor.press('ControlOrMeta+End');
    await expect
      .poll(() =>
        editor.evaluate((node) => {
          const selection = node.ownerDocument.getSelection();
          if (
            !selection?.isCollapsed ||
            !selection.focusNode ||
            !node.contains(selection.focusNode)
          )
            return false;
          const beforeCaret = node.ownerDocument.createRange();
          beforeCaret.selectNodeContents(node);
          beforeCaret.setEnd(selection.focusNode, selection.focusOffset);
          return beforeCaret.toString().length === (node.textContent ?? '').length;
        }),
      )
      .toBe(true);
    await target.keyboard.insertText(value);
    await target.keyboard.press('Escape');
  }
  await page.goto('http://127.0.0.1:4173');
  await create(page, 'animation');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  const original = await nativeArtifact(page),
    layerId = (original.draft.content as AnimationContent2).compositions[0].layers[0].id;
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const url = await page
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await page.keyboard.press('Escape');
  const context = await browser.newContext({
      viewport: page.viewportSize()!,
      isMobile: info.project.name === 'mobile',
      hasTouch: info.project.name === 'mobile',
    }),
    peer = await context.newPage(),
    errors: string[] = [];
  peer.on('pageerror', (e) => errors.push(e.message));
  peer.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await peer.goto(new URL(url!, page.url()).href);
    await expect(peer.locator('.save-status')).toContainText('Shared · confirmed');
    await page.locator(`[data-layer-id="${layerId}"] button`).click();
    await page.getByLabel('Base x', { exact: true }).fill('210');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    await expect
      .poll(
        async () =>
          ((await nativeArtifact(peer)).draft.content as AnimationContent2).compositions[0]
            .layers[0].transform.x,
      )
      .toBe(210);
    await peer.getByRole('button', { name: 'Add vector', exact: true }).click();
    await expect(peer.locator('.save-status')).toContainText('Shared · confirmed');
    await expect
      .poll(
        async () =>
          ((await nativeArtifact(page)).draft.content as AnimationContent2).compositions[0].layers
            .length,
      )
      .toBe(2);
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    const after = (await nativeArtifact(page)).draft.content as AnimationContent2;
    expect(after.compositions[0].layers).toHaveLength(2);
    expect(after.compositions[0].layers[0].transform.x).toBe(80);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(after);
    // Native shared ProseMirror steps retain the peer's later insertion through actor Undo.
    await page.getByRole('button', { name: 'Add text', exact: true }).click();
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    const textId = (
      (await nativeArtifact(page)).draft.content as AnimationContent2
    ).compositions[0].layers.find((layer) => layer.type === 'text')!.id;
    await page.locator(`[data-layer-id="${textId}"] button`).click();
    await page.getByRole('button', { name: 'Edit text on canvas', exact: true }).click();
    await appendNativeText(page, 'A');
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    await expect
      .poll(async () =>
        (
          (await nativeArtifact(peer)).draft.content as AnimationContent2
        ).compositions[0].layers.find((layer) => layer.id === textId),
      )
      .toMatchObject({ text: 'TextA' });
    await peer.locator(`[data-layer-id="${textId}"] button`).click();
    await peer.getByRole('button', { name: 'Edit text on canvas', exact: true }).click();
    await appendNativeText(peer, 'B');
    await expect(peer.locator('.save-status')).toContainText('Shared · confirmed');
    await expect
      .poll(async () =>
        (
          (await nativeArtifact(page)).draft.content as AnimationContent2
        ).compositions[0].layers.find((layer) => layer.id === textId),
      )
      .toMatchObject({ text: 'TextAB' });
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect
      .poll(async () =>
        (
          (await nativeArtifact(peer)).draft.content as AnimationContent2
        ).compositions[0].layers.find((layer) => layer.id === textId),
      )
      .toMatchObject({ text: 'TextB' });
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name: 'Pause transport (reference)', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator(`[data-layer-id="${layerId}"] button`).click();
    await page.getByLabel('Base x', { exact: true }).fill('260');
    await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
    await expect(page.locator('.save-status')).toContainText('pending');
    await expect(
      page.getByRole('button', { name: 'Export static frame…', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name: 'Resume transport (reference)', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    await expect(
      page.getByRole('button', { name: 'Export static frame…', exact: true }),
    ).toBeEnabled();
    // A remote deletion unmounts native text without blurring the editor on this peer.
    // Let B receive A's resumed geometry before capturing B's deletion plan.
    await expect
      .poll(
        async () =>
          (
            (await nativeArtifact(peer)).draft.content as AnimationContent2
          ).compositions[0].layers.find((layer) => layer.id === layerId)!.transform.x,
      )
      .toBe(260);
    await expect(peer.locator('.save-status')).toContainText('Shared · confirmed');
    await page.locator(`[data-layer-id="${textId}"] button`).click();
    await page.getByRole('button', { name: 'Edit text on canvas', exact: true }).click();
    await expect(page.locator('.ProseMirror')).toBeFocused();
    await peer.locator(`[data-layer-id="${textId}"] button`).click();
    await peer.getByRole('button', { name: 'Delete layers…', exact: true }).click();
    await peer.getByRole('button', { name: 'Confirm layer deletion', exact: true }).click();
    await expect(page.locator('.ProseMirror')).toHaveCount(0);
    await page.locator('.a2-stage svg rect[data-instance]').first().click();
    await expect(page.locator(`[data-layer-id="${layerId}"] button`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
test('2D authoring keeps mask, motion, nested time, graph and multi-key transactions through native roundtrip', async ({
  page,
}, info) => {
  const { animation2DFixture } = await import('../fixtures/animation-2d');
  const { createArtifact, commitVersion } = await import('@editor-platform/artifact-core');
  const source = animation2DFixture(
    await readFile('work/issue74-2d/japanese-subset.otf'),
    await readFile('tests/fixtures/office/images/quadrants.png'),
    await readFile('apps/playground/public/office-fonts/COPYRIGHT.txt', 'utf8'),
  );
  const original = await commitVersion(
    createArtifact('animation', '2D motion', source),
    'test',
    'Original',
  );
  await page.goto('/');
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'motion.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(original)),
  });
  await expect(page.locator('.a2-stage svg text')).toHaveText('日本語アニメーション');
  await expect(page.locator('.a2-stage svg image')).toHaveCount(1);
  await expect(page.locator('.a2-stage svg clipPath')).toHaveCount(1);
  await page.getByRole('button', { name: 'opacity key fade-first', exact: true }).click();
  await page.getByLabel('Easing', { exact: true }).selectOption('bezier');
  await page.getByLabel('Bezier x1', { exact: true }).fill('0.25');
  await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
  let record = await native(page);
  expect(record.draft.content.compositions[0].tracks[0].keys[0].easing).toMatchObject({
    type: 'bezier',
    x1: 0.25,
  });
  await page
    .getByRole('button', { name: 'opacity key fade-last', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByLabel('Move keys by frames', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Move keys', exact: true }).click();
  expect(
    (await native(page)).draft.content.compositions[0].tracks[0].keys.map((key) => key.tick),
  ).toEqual([8000, 488000]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Copy keys', exact: true }).click();
  await page.getByLabel('Animation playhead', { exact: true }).fill('240000');
  await page.getByRole('button', { name: 'Paste keys', exact: true }).click();
  expect((await native(page)).draft.content.compositions[0].tracks[0].keys).toHaveLength(4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const before = (await native(page)).draft.content;
  await page.locator('[data-layer-id="group"] button').click();
  await page.getByRole('button', { name: 'Nest layers', exact: true }).click();
  record = await native(page);
  expect(record.draft.content.compositions).toHaveLength(3);
  await page.getByRole('button', { name: 'Unnest layer', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  record = await native(page);
  expect(record.versions[0]).toEqual(original.versions[0]);
  await page.getByRole('button', { name: 'Reload saved', exact: true }).click();
  expect((await native(page)).draft.content).toEqual(record.draft.content);
  await page.screenshot({ path: info.outputPath('mask-motion-nested-graph.png'), fullPage: true });
});

test('saved Design conversion reviews the captured appearance, rejects unsupported geometry and uses one Undo', async ({
  page,
}, info) => {
  const { createDesign } = await import('@editor-platform/design/model');
  const { createArtifact, commitVersion } = await import('@editor-platform/artifact-core');
  const design = createDesign();
  design.elements = [
    {
      id: 'frame',
      type: 'frame',
      name: 'Captured frame',
      bounds: { x: 100, y: 100, width: 320, height: 240 },
      text: '',
      fill: '#ffffff',
      clipContent: true,
    },
    {
      id: 'shape',
      type: 'shape',
      name: 'Triangle',
      shape: 'triangle',
      bounds: { x: 120, y: 130, width: 80, height: 60 },
      text: '',
      fill: '#818cf8',
      parentId: 'frame',
      rotation: 15,
      flipX: true,
    },
  ];
  design.elements[0].id = 'hero card / 日本語';
  design.elements[1].id = 'triangle #1';
  design.elements[1].parentId = design.elements[0].id;
  const png = await readFile('tests/fixtures/office/images/quadrants.png');
  for (let i = 0; i < 3; i++)
    design.elements.push({
      id: `logo ${i}`,
      type: 'image',
      name: 'Logo',
      imageFit: 'fit',
      text: '',
      fill: '#ffffff',
      bounds: { x: 210 + i * 40, y: 180, width: 30, height: 30 },
      src: `data:image/png;base64,${png.toString('base64')}`,
      parentId: design.elements[0].id,
    });
  const original = await commitVersion(
    createArtifact('design', 'Design source', design),
    'test',
    'Supported',
  );
  const changed = structuredClone(design);
  changed.elements[1].shape = 'ellipse';
  const unsupportedShape = await commitVersion(
    { ...original, draft: { ...original.draft, content: changed } },
    'test',
    'Unsupported',
  );
  const omittedFit = structuredClone(design);
  for (const element of omittedFit.elements) if (element.type === 'image') delete element.imageFit;
  const record = await commitVersion(
    { ...unsupportedShape, draft: { ...unsupportedShape.draft, content: omittedFit } },
    'test',
    'Cropped default',
  );
  await page.goto('http://127.0.0.1:4173');
  const importer = page.getByLabel('Import artifact', { exact: true });
  if (!(await importer.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await importer.setInputFiles({
    name: 'design.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Design source');
  await create(page, 'animation');
  const before = await nativeArtifact(page);
  await page.getByText('Convert saved Design', { exact: true }).click();
  await page.getByLabel('Saved Design frame', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Preview Design conversion', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Design conversion preview', exact: true });
  await expect(preview.locator('svg path[data-instance]').first()).toBeVisible();
  await preview.scrollIntoViewIfNeeded();
  await preview.screenshot({ path: info.outputPath('design-conversion-review.png') });
  await page.getByRole('button', { name: 'Accept static conversion', exact: true }).click();
  const converted = await nativeArtifact(page);
  expect((converted.draft.content as AnimationContent2).compositions).toHaveLength(2);
  expect((converted.draft.content as AnimationContent2).assets).toHaveLength(1);
  const images = (converted.draft.content as AnimationContent2).compositions
    .flatMap((c) => c.layers)
    .filter((l) => l.type === 'image');
  expect(images).toHaveLength(3);
  expect(new Set(images.map((l) => l.assetId)).size).toBe(1);
  expect(
    (converted.draft.content as AnimationContent2).provenance[0].mapping.some(
      (m) => m.sourceId === 'triangle #1',
    ),
  ).toBe(true);
  expect((converted.draft.content as AnimationContent2).provenance[0].source.contentHash).toBe(
    original.versions[0].contentHash,
  );
  // Open the captured native record in the independent Host so the actual SVG
  // and PNG outputs must carry the source/mapping/losses without the Design catalog.
  (converted.draft.content as AnimationContent2).provenance[0].mapping[0].sourceId +=
    '\ufffe\uffff😀';
  const outputPage = await page.context().newPage(),
    outputErrors: string[] = [];
  outputPage.on('pageerror', (error) => outputErrors.push(error.message));
  outputPage.on('console', (message) => {
    if (message.type() === 'error') outputErrors.push(message.text());
  });
  try {
    await outputPage.goto('http://127.0.0.1:4189');
    await outputPage.getByLabel('Import Animation native', { exact: true }).setInputFiles({
      name: 'capture.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(converted)),
    });
    await outputPage
      .getByLabel('Animation composition', { exact: true })
      .selectOption((converted.draft.content as AnimationContent2).compositions[1].id);
    await expect(outputPage.locator('svg path[data-instance]').first()).toBeVisible();
    for (const format of ['SVG', 'PNG']) {
      await outputPage.getByRole('button', { name: 'Export static frame…', exact: true }).click();
      const pending = outputPage.waitForEvent('download');
      await outputPage
        .getByRole('button', { name: `Confirm ${format} export`, exact: true })
        .click();
      const bytes = await readFile((await (await pending).path())!);
      const metadata =
        format === 'SVG'
          ? await outputPage.evaluate(
              (svg) =>
                JSON.parse(
                  new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('metadata')!
                    .textContent!,
                ),
              bytes.toString(),
            )
          : pngAnimationMetadata(bytes);
      expect(metadata.provenance).toEqual([
        {
          ownerHash: (await import('@editor-platform/reuse-core')).reuseHash(
            converted.draft.content,
          ),
          records: (converted.draft.content as AnimationContent2).provenance,
        },
      ]);
      await writeFile(info.outputPath('captured-design.' + format.toLowerCase()), bytes);
    }
  } finally {
    await outputPage.close();
  }
  expect(outputErrors).toEqual([]);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Preview Design conversion', exact: true }).click();
    await page.getByRole('button', { name: 'Accept static conversion', exact: true }).click();
    const repeated = (await nativeArtifact(page)).draft.content as AnimationContent2;
    expect(repeated.assets).toHaveLength(1);
    expect(repeated.compositions).toHaveLength(3 + i);
    const imageIds = repeated.compositions
      .flatMap((c) => c.layers)
      .filter((l) => l.type === 'image')
      .map((l) => l.assetId);
    expect(imageIds).toHaveLength(6 + i * 3);
    expect(new Set(imageIds).size).toBe(1);
  }
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await page.getByLabel('Saved Design frame', { exact: true }).selectOption({ index: 2 });
  await page.getByRole('button', { name: 'Preview Design conversion', exact: true }).click();
  await expect(preview).toContainText('error:');
  await expect(
    page.getByRole('button', { name: 'Accept static conversion', exact: true }),
  ).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await page.getByLabel('Saved Design frame', { exact: true }).selectOption({ index: 3 });
  await page.getByRole('button', { name: 'Preview Design conversion', exact: true }).click();
  await expect(preview).toContainText('Cropped Design images');
  await expect(
    page.getByRole('button', { name: 'Accept static conversion', exact: true }),
  ).toHaveCount(0);
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
});

test('Slide renders the same retained 2D scene with font, image, mask and nested transforms without a catalog', async ({
  page,
  browser,
}, info) => {
  const { animation2DFixture } = await import('../fixtures/animation-2d');
  const { createArtifact, commitVersion } = await import('@editor-platform/artifact-core');
  const { evaluateAnimation2, prepareAnimation2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { artifactView } = await import('./fixtures');
  const content = animation2DFixture(
    await readFile('work/issue74-2d/japanese-subset.otf'),
    await readFile('tests/fixtures/office/images/quadrants.png'),
    await readFile('apps/playground/public/office-fonts/COPYRIGHT.txt', 'utf8'),
  );
  const source = await commitVersion(
    createArtifact('animation', 'Retained 2D source', content),
    'test',
    'Original',
  );
  async function imported(target: Page, record: unknown) {
    const field = target.getByLabel('Import artifact', { exact: true });
    if (!(await field.isVisible()))
      await target.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await field.setInputFiles({
      name: '2d.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(record)),
    });
  }
  async function tool(target: Page, name: string) {
    const button = target.getByRole('button', { name, exact: true });
    if (!(await button.isVisible()))
      await target.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await button.click();
  }
  await page.goto('http://127.0.0.1:4173');
  await imported(page, source);
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(source.name);
  await create(page, 'slide');
  await tool(page, 'アニメーションを配置');
  await page.getByRole('button', { name: 'この版を配置', exact: true }).click();
  const record = await nativeArtifact(page);
  const context = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: info.project.name === 'mobile',
    hasTouch: info.project.name === 'mobile',
  });
  const isolated = await context.newPage(),
    errors: string[] = [];
  isolated.on('pageerror', (e) => errors.push(e.message));
  isolated.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await isolated.goto('http://127.0.0.1:4173');
    await imported(isolated, record);
    await expect(isolated.getByLabel('Artifact name', { exact: true })).toHaveValue(record.name);
    await isolated
      .getByRole('application', { name: 'Slide canvas', exact: true })
      .getByRole('button', { name: 'animation object 1', exact: true })
      .click();
    if (
      !(await isolated
        .getByRole('button', { name: 'Animation をプレビュー', exact: true })
        .isVisible())
    )
      await isolated.getByRole('button', { name: 'Toggle Slide inspector', exact: true }).click();
    await isolated.getByRole('button', { name: 'Animation をプレビュー', exact: true }).click();
    const preview = isolated.getByRole('dialog', { name: 'Animation プレビュー', exact: true });
    const tick = 240000;
    await preview.getByLabel('Animation tick', { exact: true }).fill(String(tick));
    const expected = evaluateAnimation2(prepareAnimation2(content), 'root', tick);
    await expect(preview.locator('svg text')).toHaveText('日本語アニメーション');
    const transforms = await preview
      .locator('svg [data-instance]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('transform')));
    expect(transforms).toEqual(expected.items.map((item) => `matrix(${item.matrix.join(' ')})`));
    await expect(preview.locator('svg image')).toHaveCount(1);
    await expect(preview.locator('svg clipPath')).toHaveCount(1);
    await isolated.screenshot({ path: info.outputPath('retained-2d-slide.png'), fullPage: true });
    await isolated.keyboard.press('Escape');
    await artifactView(isolated, 'Editor');
    expect((await nativeArtifact(isolated)).draft.content).toEqual(record.draft.content);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('an aborted old font preparation cannot clear the newer mounted Player', async ({ page }) => {
  const { animation2DFixture } = await import('../fixtures/animation-2d');
  const { createArtifact, commitVersion } = await import('@editor-platform/artifact-core');
  const content = animation2DFixture(
    await readFile('work/issue74-2d/japanese-subset.otf'),
    await readFile('tests/fixtures/office/images/quadrants.png'),
    'Fixture license',
  );
  const record = await commitVersion(
    createArtifact('animation', 'Delayed font', content),
    'test',
    'Saved',
  );
  await page.goto('/');
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    let first = true;
    FontFace.prototype.load = function () {
      if (!first) return load.call(this);
      first = false;
      document.documentElement.dataset.oldFontWaiting = 'true';
      return new Promise<FontFace>((_resolve, reject) =>
        window.addEventListener(
          'reject-old-font',
          () => reject(Error('Delayed old font preparation failed')),
          { once: true },
        ),
      );
    };
  });
  await page.getByLabel('Import Animation native', { exact: true }).setInputFiles({
    name: 'delayed-font.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await expect(page.locator('html')).toHaveAttribute('data-old-font-waiting', 'true');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).click();
  await expect(page.locator('.a2-stage svg text')).toHaveText('日本語アニメーション');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event('reject-old-font')));
  // Let the old rejection settle before testing the current resource/clock owner.
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(page.locator('.a2-stage svg')).toHaveAttribute('data-tick', '8000');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.a2-stage svg text')).toHaveText('日本語アニメーション');
});
