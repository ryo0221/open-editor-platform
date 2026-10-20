import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDesign, type DesignContent } from '@editor-platform/design/model';
import { EditorSession } from '@editor-platform/editor-core';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  createAnimation2,
  animationCommand2,
  evaluateAnimation2,
  prepareAnimation2,
} from '@editor-platform/animation-core/v2';
import { captureDesignAnimation, adoptDesignAnimation } from './index';
function fixture(): DesignContent {
  const content = createDesign();
  content.elements = [
    {
      id: 'frame',
      type: 'frame',
      name: 'Frame',
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
  return content;
}
it('captures sibling roots in their union and retains an enclosing selected frame viewport', () => {
  const source = createDesign();
  source.elements = [
    {
      id: 'a',
      type: 'shape',
      name: 'A',
      shape: 'rectangle',
      text: '',
      fill: '#ff0000',
      bounds: { x: 10, y: 20, width: 100, height: 60 },
    },
    {
      id: 'b',
      type: 'shape',
      name: 'B',
      shape: 'rectangle',
      text: '',
      fill: '#0000ff',
      bounds: { x: 400, y: 200, width: 30, height: 50 },
    },
  ];
  const ref = {
    artifactId: 'design',
    versionId: 'v1',
    compositionId: 'selection',
    contentHash: reuseHash(source),
  };
  for (const selection of [
    ['a', 'b'],
    ['b', 'a'],
  ]) {
    const plan = captureDesignAnimation(ref, source, selection),
      c = plan.content!.compositions[0];
    expect([c.width, c.height]).toEqual([420, 230]);
    const items = evaluateAnimation2(prepareAnimation2(plan.content!), c.id, 0).items;
    expect(items.map((i) => [i.matrix[4], i.matrix[5]])).toEqual([
      [0, 0],
      [390, 180],
    ]);
  }
  source.elements.unshift({
    id: 'frame',
    type: 'frame',
    name: 'Frame',
    text: '',
    fill: '#ffffff',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    clipContent: true,
  });
  source.elements[1].parentId = 'frame';
  source.elements[2].parentId = 'frame';
  const plan = captureDesignAnimation({ ...ref, contentHash: reuseHash(source) }, source, [
    'b',
    'frame',
    'a',
  ]);
  expect([plan.content!.compositions[0].width, plan.content!.compositions[0].height]).toEqual([
    800, 600,
  ]);
});
it('captures one resolved source with fresh IDs and provenance; adoption/Undo do not edit the Design or old target', () => {
  const source = fixture(),
    bytes = JSON.stringify(source),
    ref = {
      artifactId: 'design',
      versionId: 'v1',
      compositionId: 'frame',
      contentHash: reuseHash(source),
    },
    plan = captureDesignAnimation(ref, source, ['frame']);
  expect(plan.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(plan.content).toBeDefined();
  source.elements[1].fill = '#ff0000';
  const target = createAnimation2(),
    session = new EditorSession(target);
  session.execute(adoptDesignAnimation(plan, target, plan.planHash, { canEdit: () => true }));
  const scene = evaluateAnimation2(
      prepareAnimation2(session.content),
      plan.content!.rootCompositionId,
      0,
    ),
    shape = scene.items.find((i) => i.layer.type === 'path')!;
  expect(shape.layer.type === 'path' && shape.layer.fill).toBe('#818cf8');
  expect(shape.clips).toHaveLength(1);
  expect(shape.matrix[0]).toBeLessThan(0);
  expect(
    new Set(session.content.compositions.flatMap((c) => [c.id, ...c.layers.map((l) => l.id)])).size,
  ).toBeGreaterThan(3);
  expect(session.content.provenance[0].source).toEqual(ref);
  session.undo();
  expect(session.content).toEqual(target);
  expect(bytes).not.toBe(JSON.stringify(source));
  expect(() =>
    adoptDesignAnimation({ ...plan }, target, plan.planHash, { canEdit: () => true }),
  ).toThrow('reviewed');
});
it('moves converted clipping geometry with its converted parent group', () => {
  const source = fixture();
  const plan = captureDesignAnimation(
    {
      artifactId: 'design',
      versionId: 'v1',
      compositionId: 'frame',
      contentHash: reuseHash(source),
    },
    source,
    ['frame'],
  );
  const content = plan.content!,
    c = content.compositions[0],
    group = c.layers.find((layer) => layer.type === 'group')!;
  const before = evaluateAnimation2(prepareAnimation2(content), c.id, 0).items.find(
    (item) => item.layer.type === 'path',
  )!;
  const moved = animationCommand2(
    content,
    [
      {
        type: 'layer.patch',
        compositionId: c.id,
        id: group.id,
        patch: { transform: { x: 50, y: 75 } },
      },
    ],
    { canEdit: () => true },
  ).apply(content);
  const after = evaluateAnimation2(prepareAnimation2(moved), c.id, 0).items.find(
    (item) => item.layer.type === 'path',
  )!;
  expect(after.matrix[4] - before.matrix[4]).toBeCloseTo(50);
  expect(after.clips[0].matrix[4] - before.clips[0].matrix[4]).toBeCloseTo(50);
  expect(after.clips[0].matrix[5] - before.clips[0].matrix[5]).toBeCloseTo(75);
});
it('keeps opaque Design IDs in provenance while allocating native Animation IDs', () => {
  const source = fixture();
  source.elements[0].id = 'hero card / 日本語';
  source.elements[1].id = 'triangle #1';
  source.elements[1].parentId = source.elements[0].id;
  const original = JSON.stringify(source);
  const plan = captureDesignAnimation(
    {
      artifactId: 'design',
      versionId: 'v1',
      compositionId: source.elements[0].id,
      contentHash: reuseHash(source),
    },
    source,
    [source.elements[0].id],
  );
  expect(plan.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(new Set(plan.content!.provenance[0].mapping.map((m) => m.sourceId))).toEqual(
    new Set(source.elements.map((e) => e.id)),
  );
  expect(
    plan
      .content!.compositions.flatMap((c) => [c.id, ...c.layers.map((l) => l.id)])
      .every((id) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)),
  ).toBe(true);
  const session = new EditorSession(createAnimation2()),
    before = session.content;
  session.execute(adoptDesignAnimation(plan, before, plan.planHash, { canEdit: () => true }));
  session.undo();
  expect(session.content).toEqual(before);
  expect(JSON.stringify(source)).toBe(original);
});
it('reuses repeated embedded images without merging distinct bytes', () => {
  const source = createDesign(),
    png = readFileSync('tests/fixtures/office/images/quadrants.png');
  source.elements = Array.from({ length: 102 }, (_, i) => ({
    id: `image-${i}`,
    type: 'image',
    name: 'Logo',
    imageFit: 'fit',
    text: '',
    fill: '#ffffff',
    bounds: { x: i, y: 0, width: 100, height: 100 },
    src: `data:image/png;base64,${(i === 101 ? Buffer.concat([png, Buffer.from([0])]) : png).toString('base64')}`,
  }));
  const original = JSON.stringify(source),
    plan = captureDesignAnimation(
      {
        artifactId: 'design',
        versionId: 'v1',
        compositionId: 'images',
        contentHash: reuseHash(source),
      },
      source,
      source.elements.map((e) => e.id),
    );
  expect(plan.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(plan.content!.assets).toHaveLength(2);
  const images = plan.content!.compositions[0].layers.filter((l) => l.type === 'image');
  expect(images).toHaveLength(102);
  expect(new Set(images.slice(0, 101).map((l) => l.assetId)).size).toBe(1);
  expect(images[101].assetId).not.toBe(images[0].assetId);
  expect(
    evaluateAnimation2(prepareAnimation2(plan.content!), plan.content!.rootCompositionId, 0).items,
  ).toHaveLength(102);
  expect(JSON.stringify(source)).toBe(original);
});
it('reuses equivalent target assets across fresh captures without dropping distinct notices', () => {
  const png = Buffer.alloc(1536 * 1024);
  readFileSync('tests/fixtures/office/images/quadrants.png').copy(png);
  const source = createDesign();
  source.elements = [
    {
      id: 'logo',
      type: 'image',
      name: 'Logo',
      imageFit: 'fit',
      text: '',
      fill: '#ffffff',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      src: `data:image/png;base64,${png.toString('base64')}`,
    },
  ];
  const ref = {
    artifactId: 'design',
    versionId: 'v1',
    compositionId: 'logo',
    contentHash: reuseHash(source),
  };
  const plans = Array.from({ length: 3 }, () => captureDesignAnimation(ref, source, ['logo']));
  const captured = plans.map((plan) => JSON.stringify(plan.content));
  const session = new EditorSession(createAnimation2());
  for (const plan of plans) {
    session.execute(
      adoptDesignAnimation(plan, session.content, plan.planHash, { canEdit: () => true }),
    );
    expect(session.content.assets).toHaveLength(1);
    expect(
      session.content.compositions
        .flatMap((c) => c.layers)
        .filter((l) => l.type === 'image')
        .every((l) => l.assetId === session.content.assets[0].id),
    ).toBe(true);
  }
  const otherNotice = captureDesignAnimation({ ...ref, artifactId: 'another-design' }, source, [
    'logo',
  ]);
  session.execute(
    adoptDesignAnimation(otherNotice, session.content, otherNotice.planHash, {
      canEdit: () => true,
    }),
  );
  expect(session.content.assets).toHaveLength(2);
  expect(session.content.assets[1].attribution).toContain('another-design');
  session.undo();
  expect(session.content.assets).toHaveLength(1);
  expect(plans.map((plan) => JSON.stringify(plan.content))).toEqual(captured);
}, 30000);
it.each([undefined, 'fill'] as const)(
  'refuses Design image fit %s rather than changing cropped appearance',
  (imageFit) => {
    const source = createDesign(),
      png = readFileSync('tests/fixtures/office/images/quadrants.png');
    source.elements = [
      {
        id: 'image',
        type: 'image',
        name: 'Image',
        text: '',
        fill: '#ffffff',
        bounds: { x: 0, y: 0, width: 300, height: 40 },
        src: `data:image/png;base64,${png.toString('base64')}`,
        ...(imageFit ? { imageFit } : {}),
      },
    ];
    const before = JSON.stringify(source),
      ref = {
        artifactId: 'design',
        versionId: 'v1',
        compositionId: 'image',
        contentHash: reuseHash(source),
      };
    const plan = captureDesignAnimation(ref, source, ['image']);
    expect(plan.content).toBeUndefined();
    expect(
      plan.diagnostics.some((d) => d.severity === 'error' && d.message.includes('Cropped')),
    ).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
    source.elements[0].imageFit = 'fit';
    expect(
      captureDesignAnimation({ ...ref, contentHash: reuseHash(source) }, source, ['image']).content,
    ).toBeDefined();
  },
);
it('reports unsupported and changed source captures without partially applying them', () => {
  const source = fixture();
  source.elements[1].shape = 'ellipse';
  const ref = {
      artifactId: 'design',
      versionId: 'v1',
      compositionId: 'frame',
      contentHash: reuseHash(source),
    },
    plan = captureDesignAnimation(ref, source, ['frame']);
  expect(plan.content).toBeUndefined();
  expect(plan.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  expect(() =>
    adoptDesignAnimation(plan, createAnimation2(), plan.planHash, { canEdit: () => true }),
  ).toThrow();
  expect(() =>
    captureDesignAnimation({ ...ref, contentHash: '0'.repeat(64) }, source, ['frame']),
  ).toThrow('hash mismatch');
});
