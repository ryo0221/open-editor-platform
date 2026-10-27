import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  f02Plate,
  f12Holes,
  f18Sheets,
  identityQuaternion,
  mm,
} from '@editor-platform/cad-core';
import { modelTree, type CadTreeNode } from './model-tree';

const shape = (nodes: CadTreeNode[]): unknown[] =>
  nodes.map((n) =>
    n.kind === 'body'
      ? { body: n.body.id, children: shape(n.children) }
      : n.tools.length
        ? { feature: n.feature.id, tools: shape(n.tools) }
        : n.feature.id,
  );

describe('body and feature tree (U5)', () => {
  it('lists each active body with its features, and the tools a Boolean consumed under it', () => {
    expect(shape(modelTree(f12Holes()))).toEqual([
      {
        body: 'part',
        children: [
          'block',
          'part-placement',
          {
            feature: 'holes',
            tools: [
              { body: 'a', children: ['cyl-a', 'a-placement'] },
              { body: 'b', children: ['cyl-b', 'b-placement'] },
            ],
          },
          'holes-placement',
          'rim',
          'rim-placement',
        ],
      },
    ]);
  });

  it('shows every feature once, consumed or not', () => {
    const doc = f02Plate();
    const ids: string[] = [];
    const visit = (nodes: CadTreeNode[]) => {
      for (const n of nodes)
        if (n.kind === 'body') visit(n.children);
        else {
          ids.push(n.feature.id);
          visit(n.tools);
        }
    };
    visit(modelTree(doc));
    expect(ids.sort()).toEqual(doc.features.map((f) => f.id).sort());
  });

  it('lists a feature two bodies read under each of them', () => {
    const doc = f02Plate();
    const plate = doc.bodies.find((b) => b.id === 'plate')!;
    const source = doc.features.find((f) => f.id === plate.resultFeatureId)!.inputFeatureIds[0]!;
    // A second body placed from the same shape the plate's placement reads.
    const shared = applyCadOperation(doc, {
      type: 'insertFeatures',
      features: [
        {
          id: 'copy-placement',
          name: 'Copy placement',
          type: 'transform',
          inputFeatureIds: [source],
          args: { translation: [mm(0), mm(0), mm(50)], rotation: identityQuaternion() },
        },
      ],
    });
    const withCopy = {
      ...shared,
      bodies: [
        ...shared.bodies,
        { ...plate, id: 'copy', name: 'Copy', resultFeatureId: 'copy-placement' },
      ],
    };
    const [first, second] = modelTree(withCopy);
    const flat = (n: CadTreeNode): string[] =>
      n.kind === 'body' ? n.children.flatMap(flat) : [n.feature.id, ...n.tools.flatMap(flat)];
    expect(flat(second!)).toContain(source);
    expect(flat(first!)).toContain(source);
    expect(new Set(flat(second!)).size).toBe(flat(second!).length);
  });

  it('walks a consumed tool normally for a reader other than its consuming feature', () => {
    const doc = f12Holes();
    const shared = applyCadOperation(doc, {
      type: 'insertFeatures',
      features: [
        {
          id: 'copy-placement',
          name: 'Copy placement',
          type: 'transform',
          inputFeatureIds: ['a-placement'],
          args: { translation: [mm(0), mm(0), mm(50)], rotation: identityQuaternion() },
        },
      ],
    });
    const part = shared.bodies.find((b) => b.id === 'part')!;
    const withCopy = {
      ...shared,
      bodies: [
        ...shared.bodies,
        { ...part, id: 'copy', name: 'Copy', resultFeatureId: 'copy-placement' },
      ],
    };
    const copy = modelTree(withCopy).find((n) => n.body.id === 'copy')!;
    expect(shape(copy.children)).toEqual(['cyl-a', 'a-placement', 'copy-placement']);
  });

  it('lists the features a feature reads through its args', () => {
    // The trim reads the blade's placement through `args.tool`, not its inputs.
    const [surface] = modelTree(f18Sheets({ kind: 'trim', tool: 'wall', keep: 'front' }));
    expect(shape(surface!.children)).toEqual([
      'blade-wall',
      'blade-placement',
      'sheet',
      'surface-placement',
      'cut',
      'cut-placement',
    ]);
  });

  it('orders features by evaluation, not by their place in the document', () => {
    const doc = f18Sheets({ kind: 'trim', tool: 'wall', keep: 'front' });
    // The blade's features moved after the trim that reads them through args.
    const blade = new Set(['blade-wall', 'blade-placement']);
    const moved = {
      ...doc,
      features: [
        ...doc.features.filter((f) => !blade.has(f.id)),
        ...doc.features.filter((f) => blade.has(f.id)),
      ],
    };
    const [surface] = modelTree(moved);
    const ids = shape(surface!.children) as string[];
    expect(ids.indexOf('blade-placement')).toBeLessThan(ids.indexOf('cut'));
    expect(ids.indexOf('blade-wall')).toBeLessThan(ids.indexOf('blade-placement'));
  });
});
