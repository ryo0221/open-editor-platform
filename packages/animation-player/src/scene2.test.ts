import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  createAnimation2,
  createAnimationLayer2,
  encodeAnimationBase64,
  hashAnimationBytes2,
  evaluateAnimation2,
  prepareAnimation2,
  type Layer2,
  type PathCommand2,
} from '@editor-platform/animation-core/v2';
import {
  animationSceneSvg2,
  planAnimationFrame2,
  animationFramePreview2,
  exportAnimationFrame2,
  prepareAnimationResources2,
} from './scene2';

function pathInstances(copies: number, coordinate: number) {
  const content = createAnimation2(),
    root = content.compositions[0];
  const path = createAnimationLayer2('path', 'curve', root.duration);
  if (path.type !== 'path') throw Error();
  path.path = [
    ['M', coordinate, coordinate],
    ...Array.from(
      { length: 511 },
      (): PathCommand2 => [
        'C',
        coordinate,
        coordinate,
        coordinate,
        coordinate,
        coordinate,
        coordinate,
      ],
    ),
  ];
  content.compositions.push({ ...structuredClone(root), id: 'child', layers: [path] });
  root.layers = Array.from({ length: copies }, (_, i) => ({
    ...createAnimationLayer2('group', `instance-${i}`, root.duration),
    type: 'composition' as const,
    source: { type: 'local' as const, compositionId: 'child' },
    time: {
      sourceIn: 0,
      sourceOut: root.duration,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold' as const,
    },
  }));
  return content;
}
function richInstances(copies: number, length: number) {
  const content = pathInstances(copies, 0),
    child = content.compositions[1];
  const layer = createAnimationLayer2('text', 'rich', child.duration);
  if (layer.type !== 'text') throw Error();
  layer.text = 'A'.repeat(length);
  layer.runs = Array.from({ length }, (_, i) => ({
    text: 'A',
    style: { bold: i % 2 === 0, color: i % 2 === 0 ? '#ff0000' : '#0000ff' },
  }));
  child.layers = [layer];
  return content;
}
it('bounds expanded normalized rich-run markup before SVG serialization', () => {
  expect(() =>
    animationSceneSvg2(evaluateAnimation2(prepareAnimation2(richInstances(4, 20000)), 'root', 0)),
  ).toThrow('expansion');
  const source = prepareAnimation2(richInstances(2, 4000)),
    svg = animationSceneSvg2(evaluateAnimation2(source, 'root', 0));
  expect(svg).toContain('font-weight="700"');
  expect(svg).toContain('fill="#0000ff"');
  expect(svg.length).toBeLessThan(8 * 1024 * 1024);
  expect(() => planAnimationFrame2(source, 'root', 0)).not.toThrow();
}, 30000);
it('applies the same serialized text budget to private input values before output', () => {
  const content = richInstances(4, 1);
  content.publicInputs = [
    {
      id: 'caption',
      name: 'Caption',
      kind: 'text',
      default: 'A',
      min: 0,
      max: 20000,
      target: { compositionId: 'child', layerId: 'rich', property: 'text' },
    },
  ];
  const prepared = prepareAnimation2(content);
  expect(() =>
    evaluateAnimation2(prepared, 'root', 0, [{ inputId: 'caption', value: 'A\n'.repeat(10000) }]),
  ).toThrow('scene-expansion');
}, 30000);
it('accounts for serialized vector data rather than only expanded command count', () => {
  expect(() =>
    animationSceneSvg2(
      evaluateAnimation2(prepareAnimation2(pathInstances(390, -1000000)), 'root', 0),
    ),
  ).toThrow('expansion');
  const source = prepareAnimation2(pathInstances(390, 0));
  expect(animationSceneSvg2(evaluateAnimation2(source, 'root', 0)).length).toBeLessThan(
    8 * 1024 * 1024,
  );
  expect(() => planAnimationFrame2(source, 'root', 0)).not.toThrow();
}, 30000);

it('prepares only resources reachable through the selected composition closure', async () => {
  const content = createAnimation2(),
    other = { ...structuredClone(content.compositions[0]), id: 'other' };
  const bytes = readFileSync('tests/fixtures/office/images/quadrants.png');
  content.assets = [
    {
      id: 'picture',
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'image/png',
      base64: encodeAnimationBase64(bytes),
      attribution: 'Fixture',
      license: 'Notice',
    },
  ];
  other.layers = [
    {
      ...createAnimationLayer2('group', 'image', other.duration),
      type: 'image',
      width: 100,
      height: 100,
      assetId: 'picture',
    },
  ];
  content.compositions.push(other);
  const decode = vi.fn().mockRejectedValue(new Error('Undecodable image'));
  vi.stubGlobal('createImageBitmap', decode);
  try {
    const source = prepareAnimation2(content),
      doc = {} as Document;
    const resources = await prepareAnimationResources2(source, doc);
    resources.dispose();
    expect(decode).not.toHaveBeenCalled();
    const plan = planAnimationFrame2(source, 'root', 0);
    await expect(
      exportAnimationFrame2(plan, {
        acceptedPlanHash: plan.planHash,
        format: 'svg',
        document: doc,
        canRead: () => true,
      }),
    ).resolves.toBeInstanceOf(Blob);
    await expect(prepareAnimationResources2(source, doc, undefined, 'other')).rejects.toThrow(
      'Undecodable',
    );
    expect(decode).toHaveBeenCalledTimes(1);
    content.compositions[0].layers = [
      {
        ...createAnimationLayer2('group', 'nested', other.duration),
        type: 'composition',
        source: { type: 'local', compositionId: 'other' },
        time: {
          sourceIn: 0,
          sourceOut: other.duration,
          rate: { numerator: 1, denominator: 1 },
          after: 'hold',
        },
      },
    ];
    await expect(prepareAnimationResources2(prepareAnimation2(content), doc)).rejects.toThrow(
      'Undecodable',
    );
    const retained = createAnimation2();
    retained.sources = [
      {
        ref: {
          artifactId: 'provider',
          versionId: 'v1',
          compositionId: 'other',
          contentHash: (await import('@editor-platform/reuse-core')).reuseHash(content),
        },
        content,
      },
    ];
    const retainedBytes = JSON.stringify(retained);
    const unused = await prepareAnimationResources2(prepareAnimation2(retained), doc);
    unused.dispose();
    expect(JSON.stringify(retained)).toBe(retainedBytes);
    expect(decode).toHaveBeenCalledTimes(2);
    retained.compositions[0].layers = [
      {
        ...createAnimationLayer2('group', 'exact', other.duration),
        type: 'composition',
        source: { type: 'exact', ref: retained.sources[0].ref },
        time: {
          sourceIn: 0,
          sourceOut: other.duration,
          rate: { numerator: 1, denominator: 1 },
          after: 'hold',
        },
      },
    ];
    await expect(prepareAnimationResources2(prepareAnimation2(retained), doc)).rejects.toThrow(
      'Undecodable',
    );
    expect(decode).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

function clippedInstances(copies: number) {
  const content = createAnimation2(),
    root = content.compositions[0];
  const child = {
    ...structuredClone(root),
    id: 'child',
    layers: Array.from({ length: 100 }, (_, i) =>
      createAnimationLayer2('rect', `box-${i}`, root.duration),
    ),
  };
  content.compositions.push(child);
  for (let i = 0; i < 10; i++) {
    const mask = createAnimationLayer2('rect', `mask-${i}`, root.duration);
    mask.maskOnly = true;
    if (i) mask.clipId = `mask-${i - 1}`;
    root.layers.push(mask);
  }
  const group = createAnimationLayer2('group', 'clipped-group', root.duration);
  group.clipId = 'mask-9';
  root.layers.push(group);
  for (let i = 0; i < copies; i++)
    root.layers.push({
      ...createAnimationLayer2('group', `instance-${i}`, root.duration),
      type: 'composition',
      parentId: group.id,
      source: { type: 'local', compositionId: child.id },
      time: {
        sourceIn: 0,
        sourceOut: root.duration,
        rate: { numerator: 1, denominator: 1 },
        after: 'hold',
      },
    });
  return content;
}
it('rejects excessive nested clip expansion during validation before SVG serialization', () => {
  expect(() => {
    const source = prepareAnimation2(clippedInstances(159));
    animationSceneSvg2(evaluateAnimation2(source, 'root', 0));
  }).toThrow('expansion');
}, 30000);
it('serializes an admitted nested clip fixture within the static SVG bound', () => {
  const source = prepareAnimation2(clippedInstances(32)),
    scene = evaluateAnimation2(source, 'root', 0);
  expect(scene.items).toHaveLength(3200);
  expect(scene.items.reduce((n, item) => n + item.clips.length, 0)).toBe(32000);
  expect(animationSceneSvg2(scene).length).toBeLessThan(8 * 1024 * 1024);
  expect(() => planAnimationFrame2(source, 'root', 0)).not.toThrow();
}, 30000);

it('shares retained image and clip definitions while static output keeps exact source and resource notices', () => {
  const content = createAnimation2(),
    c = content.compositions[0];
  const bytes = readFileSync('tests/fixtures/office/images/quadrants.png');
  content.assets.push({
    id: 'picture',
    contentHash: hashAnimationBytes2(bytes),
    mediaType: 'image/png',
    base64: encodeAnimationBase64(bytes),
    attribution: 'Fixture image',
    license: 'Retained notice',
  });
  const mask = createAnimationLayer2('path', 'mask', c.duration);
  mask.maskOnly = true;
  c.layers = [
    mask,
    ...Array.from(
      { length: 20 },
      (_, index): Layer2 => ({
        ...createAnimationLayer2('group', 'image-' + index, c.duration),
        type: 'image',
        width: 80,
        height: 40,
        assetId: 'picture',
        clipId: 'mask',
      }),
    ),
  ];
  const source = prepareAnimation2(content),
    scene = evaluateAnimation2(source, c.id, 0);
  const svg = animationSceneSvg2(scene);
  expect(svg.match(/data:image\/png;base64,/g)).toHaveLength(1);
  expect(svg.match(/<clipPath /g)).toHaveLength(1);
  expect(svg.match(/<use /g)).toHaveLength(20);
  expect(svg).toContain('Retained notice');
  expect(svg).toContain(source.contentHash);
  expect(animationSceneSvg2(scene, 'preview', false)).not.toContain('<metadata>');
  const plan = planAnimationFrame2(source, c.id, 0);
  expect(animationFramePreview2(plan)).toBe(svg);
  expect(() => animationFramePreview2({ ...plan })).toThrow('Unknown');
});
it('refuses forged, unreviewed, revoked and cancelled static exports before accessing browser resources', async () => {
  const source = prepareAnimation2(createAnimation2()),
    plan = planAnimationFrame2(source, 'root', 0);
  const options = {
    acceptedPlanHash: plan.planHash,
    format: 'svg' as const,
    document: {} as Document,
    canRead: () => false,
  };
  await expect(exportAnimationFrame2({ ...plan }, options)).rejects.toThrow('exact');
  await expect(
    exportAnimationFrame2(plan, { ...options, acceptedPlanHash: 'other' }),
  ).rejects.toThrow('exact');
  await expect(exportAnimationFrame2(plan, options)).rejects.toThrow('revoked');
  await expect(
    exportAnimationFrame2(plan, { ...options, canRead: () => true, signal: AbortSignal.abort() }),
  ).rejects.toThrow('cancelled');
});

it.each([
  [16384, 16384],
  [4096.1, 4095.9],
])(
  'rejects excessive PNG raster area %s × %s before resources and still permits SVG',
  async (width, height) => {
    const content = createAnimation2();
    content.compositions[0].width = width;
    content.compositions[0].height = height;
    const plan = planAnimationFrame2(prepareAnimation2(content), 'root', 0);
    const options = {
      acceptedPlanHash: plan.planHash,
      document: {} as Document,
      canRead: () => true,
    };
    await expect(exportAnimationFrame2(plan, { ...options, format: 'png' })).rejects.toThrow(
      '16 Mi pixels',
    );
    const svg = await exportAnimationFrame2(plan, { ...options, format: 'svg' });
    expect(await svg.text()).toContain(`viewBox="0 0 ${width} ${height}"`);
  },
);

it('retains captured source, mapping and reviewed losses in standalone SVG provenance', () => {
  const content = createAnimation2(),
    root = content.compositions[0];
  root.layers = [createAnimationLayer2('rect', 'box', root.duration)];
  content.provenance = [
    {
      source: {
        artifactId: 'Design source',
        versionId: 'v1',
        compositionId: 'frame',
        contentHash: 'a'.repeat(64),
      },
      mapping: [{ sourceId: '図形<&\ufffe', layerId: 'box' }],
      losses: ['Reviewed <loss> & note'],
    },
  ];
  const scene = evaluateAnimation2(prepareAnimation2(content), root.id, 0);
  expect(scene).toMatchObject({ provenance: [{ records: content.provenance }] });
  const svg = animationSceneSvg2(scene);
  expect(svg).not.toContain('\ufffe');
  expect(svg).toContain('Reviewed &lt;loss&gt; &amp; note');
  const parent = createAnimation2(),
    ref = {
      artifactId: 'retained',
      versionId: 'v1',
      compositionId: root.id,
      contentHash: reuseHash(content),
    };
  parent.sources = [{ ref, content }];
  parent.compositions[0].layers = ['first', 'second'].map((id) => ({
    ...createAnimationLayer2('group', id, root.duration),
    type: 'composition' as const,
    source: { type: 'exact' as const, ref },
    time: {
      sourceIn: 0,
      sourceOut: root.duration,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold' as const,
    },
  }));
  const nested = evaluateAnimation2(prepareAnimation2(parent), parent.rootCompositionId, 0);
  expect(nested.items).toHaveLength(2);
  expect(nested.provenance).toEqual([{ ownerHash: ref.contentHash, records: content.provenance }]);
  expect(animationSceneSvg2(nested)).toContain('Reviewed &lt;loss&gt; &amp; note');
});
