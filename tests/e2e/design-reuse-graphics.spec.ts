import { assertPost258, assertForeignVectorUpdate } from './post-258-fixtures';
import { readFile } from 'node:fs/promises';
import { test, expect, create, nativeArtifact, save, artifactView } from './fixtures';
import {
  independentDesignReuse,
  assertButtonPng,
  assertVectorViewport,
  assertVectorOccurrences,
  assertInputDiagnostics,
  assertExpandedTextLayout,
} from './design-reuse-graphics-fixtures';
import { smallButton } from '../fixtures/design-reuse/content';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { createDesign, makeDesignVector, exportDesignSvg } from '@editor-platform/design/model';
import { createDeck, makeSlideObject } from '@editor-platform/slide/model';
import {
  createWhiteboard,
  insertNode,
  connectNodes,
  makeWhiteboardNode,
} from '@editor-platform/whiteboard/model';
import { createSection } from '@editor-platform/whiteboard/sections';
import { createData, makeRow } from '@editor-platform/structured-data/model';
import { checkVector, compactArcPaths } from '../fixtures/design-reuse/content';

test('public Host renders expanded rich line height and sequential fill labels after native reload', async ({
  page,
}, info) => {
  await assertExpandedTextLayout(page);
  await page.screenshot({ path: info.outputPath('expanded-text-layout.png') });
});

test('public TemplateInputForm highlights the overflowing component input and preserves native content', async ({
  page,
}, info) => {
  await assertInputDiagnostics(page);
  await page.screenshot({ path: info.outputPath('component-input-diagnostics.png') });
});

test('compact SVG arcs match expanded flags and valid Unicode provenance exports parseable XML', async ({
  page,
}, info) => {
  const source = '許諾 🚀 <&"\t\n\r \ud7ff\ue000\ufffd\u{10000}\u{10ffff}';
  const viewBox = { x: -10, y: -15, width: 50, height: 50, onload: 'ignored', extra: '\u0001' };
  const content = {
    ...createDesign(),
    elements: compactArcPaths.flatMap((pair, index) =>
      pair.map((path, column) => ({
        ...makeDesignVector({
          ...checkVector,
          viewBox,
          paths: [path],
          provenance: { ...checkVector.provenance, source },
        }),
        bounds: { x: index * 120 + column * 60, y: 0, width: 50, height: 50 },
      })),
    ),
  };
  await independentDesignReuse(page, content);
  const paths = page.locator('svg [data-vector-source] path');
  await expect(paths).toHaveCount(10);
  const geometry = await paths.evaluateAll((nodes) =>
    nodes.map((node) => {
      const path = node as SVGPathElement;
      const length = path.getTotalLength();
      return {
        length,
        points: [0, 0.5, 1].map((fraction) => {
          const point = path.getPointAtLength(length * fraction);
          return { x: point.x, y: point.y };
        }),
      };
    }),
  );
  for (let index = 0; index < geometry.length; index += 2) {
    expect(geometry[index].length).toBeGreaterThan(0);
    expect(geometry[index].length).toBeCloseTo(geometry[index + 1].length, 4);
    for (let point = 0; point < 3; point++) {
      expect(geometry[index].points[point].x).toBeCloseTo(geometry[index + 1].points[point].x, 4);
      expect(geometry[index].points[point].y).toBeCloseTo(geometry[index + 1].points[point].y, 4);
    }
  }
  const svg = exportDesignSvg(content);
  expect(svg).toContain('許諾 🚀 &lt;&amp;&quot;');
  expect(
    await page.evaluate(
      (source) =>
        new DOMParser().parseFromString(source, 'image/svg+xml').querySelectorAll('parsererror')
          .length,
      svg,
    ),
  ).toBe(0);
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(content);
  await page.screenshot({ path: info.outputPath('compact-arcs-unicode-provenance.png') });
});

test('public Host and direct primitives keep colliding drawing IDs within their own view boxes', async ({
  page,
}, info) => {
  await assertVectorOccurrences(page);
  await page.screenshot({ path: info.outputPath('unique-vector-occurrences.png') });
});

test('SVG-supported whitespace produces drawable paths and parseable exported XML', async ({
  page,
}, info) => {
  const content = {
    ...createDesign(),
    elements: [' ', '\t', '\r', '\n'].map((separator, index) => ({
      ...makeDesignVector(
        {
          ...checkVector,
          paths: [`${separator}M0${separator}0${separator}L24,${separator}24${separator}`],
        },
        index,
      ),
      bounds: { x: index * 30, y: 0, width: 24, height: 24 },
    })),
  };
  await independentDesignReuse(page, content);
  const paths = page.locator('svg [data-vector-source] path');
  await expect(paths).toHaveCount(4);
  const lengths = await paths.evaluateAll((nodes) =>
    nodes.map((node) => (node as SVGPathElement).getTotalLength()),
  );
  for (const length of lengths) expect(length).toBeCloseTo(Math.hypot(24, 24), 4);
  expect(
    await page.evaluate(
      (svg) =>
        new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('parsererror')
          .length,
      exportDesignSvg(content),
    ),
  ).toBe(0);
  await page.screenshot({ path: info.outputPath('svg-path-whitespace.png') });
});

for (const kind of ['whiteboard', 'data'] as const) {
  test(`ordinary ${kind} custom SVG export uses Noto for Japanese labels`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await create(page, kind);
    const record = await nativeArtifact(page);
    if (kind === 'whiteboard') {
      let content = {
        ...createWhiteboard(),
        nodes: [
          { ...makeWhiteboardNode('sticky'), id: 'a', text: '調査' },
          {
            ...makeWhiteboardNode('sticky'),
            id: 'b',
            text: '確認',
            bounds: { x: 300, y: 100, width: 170, height: 120 },
          },
        ],
      };
      content = createSection({ x: 0, y: 0, width: 600, height: 300 }, '日本語の枠', [
        'a',
        'b',
      ]).apply(content);
      content = connectNodes('a', 'b').apply(content);
      content.connectors[0].label = '日本語の接続';
      record.draft.content = content;
    } else {
      const content = createData();
      content.columns[4].name = '日本語の合計';
      content.rows = [makeRow(content)];
      record.draft.content = content;
    }
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'japanese-font.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(record)),
    });
    if (kind === 'data')
      await page.getByLabel('Data projection', { exact: true }).selectOption('Chart');
    await page
      .getByRole('button', {
        name: kind === 'data' ? 'Export data' : 'Export whiteboard',
        exact: true,
      })
      .click();
    const pending = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name: kind === 'data' ? 'Export chart SVG' : 'Export all SVG',
        exact: true,
      })
      .click();
    const svg = await readFile((await (await pending).path())!, 'utf8');
    expect(svg).toContain('font-family="Noto Sans CJK JP, sans-serif"');
    expect(svg).toContain('日本語');
    expect(svg).not.toContain('Arial');
    const parsed = await page.evaluate(async (source) => {
      const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
      const image = new Image();
      image.alt = 'Japanese SVG export';
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
      image.style.maxWidth = '90%';
      await image.decode();
      document.body.append(image);
      return {
        errors: doc.querySelectorAll('parsererror').length,
        family: doc.querySelector('svg > g')?.getAttribute('font-family'),
      };
    }, svg);
    expect(parsed).toEqual({ errors: 0, family: 'Noto Sans CJK JP, sans-serif' });
    await page.screenshot({ path: info.outputPath(`${kind}-japanese-svg.png`), fullPage: true });
  });
}

for (const rotated of [false, true]) {
  test(`public Host clips oversized paths to their view box in PNG, rotated=${rotated}`, async ({
    page,
  }, info) => {
    await assertVectorViewport(page, rotated);
    await page.screenshot({ path: info.outputPath('clipped-vector.png') });
  });
}

test('public Host inserts small linked text, renders mode colors in SVG/PNG and retains native history', async ({
  page,
}, info) => {
  await independentDesignReuse(page);
  const native = page.getByTestId('reuse-native');
  const light = await native.textContent();
  await expect(page.locator('svg path[d="M20 6 9 17l-5-5"]')).toHaveAttribute('stroke', '#336699');
  await assertButtonPng(page, [51, 102, 153]);
  await page.getByRole('button', { name: 'Host dark mode', exact: true }).click();
  await expect(native).toContainText('"artifactMode":"dark"');
  await expect(page.locator('svg path[d="M20 6 9 17l-5-5"]')).toHaveAttribute('stroke', '#ff9933');
  await assertButtonPng(page, [255, 153, 51]);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Host export SVG', exact: true }).click();
  const exported = await readFile((await (await pending).path())!, 'utf8');
  expect(exported).toContain('stroke="#ff9933"');
  expect(exported).toContain('data-vector-license="ISC"');
  expect(exported).toContain('Noto Sans CJK JP');
  expect(exported).not.toContain('Arial');
  await page.screenshot({ path: info.outputPath('dark-vector.png') });
  await page.getByRole('button', { name: 'Host undo', exact: true }).click();
  await expect(native).toHaveText(light!);
  await page.getByRole('button', { name: 'Host redo', exact: true }).click();
  const dark = await native.textContent();
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  await expect(native).toHaveText(dark!);
  await page.getByLabel('Host read only', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Host light mode', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+z');
  await expect(native).toHaveText(dark!);
});

for (const kind of ['slide', 'whiteboard'] as const) {
  test(`ordinary ${kind} renders imported unknown vector metadata and preserves native export`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await create(page, kind);
    const record = await nativeArtifact(page);
    const content =
      kind === 'slide' ? createDeck() : insertNode('rectangle').apply(createWhiteboard());
    if ('slides' in content) {
      content.slides[0].objects = [{ ...makeSlideObject('shape', 0), shape: 'rectangle' }];
      Object.assign(content.slides[0].objects[0], { vector: {} });
    } else Object.assign(content.nodes[0], { vector: {} });
    record.draft.content = content;
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'foreign-vector.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(record)),
    });
    const canvas = page.getByRole('application', {
      name: kind === 'slide' ? 'Slide canvas' : 'Whiteboard canvas',
      exact: true,
    });
    await expect(canvas).toBeVisible();
    expect(await canvas.locator('rect').count()).toBeGreaterThan(0);
    await expect(canvas.locator('[data-vector-source]')).toHaveCount(0);
    expect((await nativeArtifact(page)).draft.content).toEqual(content);
    await page.screenshot({ path: info.outputPath(`${kind}-foreign-vector.png`) });
  });
}

test('ordinary version comparison shows vector geometry fingerprints and source/license changes', async ({
  page,
}, info) => {
  const icon = { ...makeDesignVector(checkVector), id: 'icon' };
  const before = await commitVersion(
    createArtifact('design', 'Vector comparison', { ...createDesign(), elements: [icon] }),
    'review',
    'Original',
  );
  const after = structuredClone(before);
  after.draft.content.elements[0].vector!.paths = ['M0 0L24 24'];
  after.draft.content.elements[0].vector!.provenance = {
    source: 'Host',
    name: 'New mark',
    version: '2',
    license: 'CC0-1.0',
  };
  const record = await commitVersion(after, 'review', 'Changed geometry and attribution');
  await page.goto('/');
  // Open Library and complete initial storage loading before importing this fixture.
  await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(page.getByRole('button', { name: /New artifact$/ })).toBeEnabled();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'vector-versions.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(record.name);
  await artifactView(page, 'Compare');
  const descriptions = page.locator('.change .text-pair pre');
  await expect(descriptions).toHaveCount(2);
  await expect(descriptions.first()).toContainText('source lucide');
  await expect(descriptions.first()).toContainText('license ISC');
  await expect(descriptions.last()).toContainText('source Host');
  await expect(descriptions.last()).toContainText('license CC0-1.0');
  const oldGeometry = (await descriptions.first().textContent())!.match(
    /Vector geometry: (\w+)/,
  )![1];
  const newGeometry = (await descriptions.last().textContent())!.match(
    /Vector geometry: (\w+)/,
  )![1];
  expect(newGeometry).not.toBe(oldGeometry);
  await page.screenshot({ path: info.outputPath('vector-version-compare.png') });
});

test('ordinary Design edits vector paint, undoes, saves, reloads and preserves native provenance', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  const record = await nativeArtifact(page);
  record.draft.content = smallButton();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'vector.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(record)),
  });
  await page.getByRole('button', { name: 'Layer Check', exact: true }).click();
  const stroke = page.getByLabel('Stroke', { exact: true });
  await stroke.fill('#ff9933');
  await stroke.press('Enter');
  await expect(page.locator('svg path[d="M20 6 9 17l-5-5"]')).toHaveAttribute('stroke', '#ff9933');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('svg path[d="M20 6 9 17l-5-5"]')).toHaveAttribute('stroke', '#253044');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await save(page, 1);
  await page.reload();
  const resumed = await nativeArtifact(page);
  expect(
    (resumed.draft.content as ReturnType<typeof smallButton>).elements.find(
      (e) => e.id === 'check',
    ),
  ).toMatchObject({
    stroke: '#ff9933',
    vector: { provenance: { source: 'lucide', version: '1.51.0', license: 'ISC' } },
  });
  await page.screenshot({ path: info.outputPath('ordinary-vector.png') });
});

test('post-258 adopted vector and effective small run survive SVG export and native reload', async ({
  page,
}, info) => {
  await assertPost258(page);
  await page.screenshot({ path: info.outputPath('post-258.png') });
});

for (const domain of ['slide', 'whiteboard'] as const)
  for (const change of ['change', 'delete'] as const)
    test(`${domain} keeps opaque vector on definition ${change} through saved native reload`, async ({
      page,
    }, info) => {
      await assertForeignVectorUpdate(page, domain, change);
      await page.screenshot({ path: info.outputPath(`${domain}-${change}-opaque-vector.png`) });
    });
