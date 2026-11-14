import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { validateGeometry, type GeometryGraph } from '@editor-platform/geometry-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import type { OcModule } from './module';
import { evaluateGeometry } from './ops';
import { stepString } from './step';

// PB7c (docs/cad/pcb-design.md, ST-469): named shapes as one STEP file. TS-1947 request
// checks, TS-1948 AP214/AP242 files read back with OCCT's reader (development build).

const box = (x: number, w: number, h: number, holes = false) => ({
  op: 'prism' as const,
  frame: {
    origin: [x, 0, 0] as [number, number, number],
    x: [1, 0, 0] as [number, number, number],
    z: [0, 0, 1] as [number, number, number],
  },
  outer: [
    [0, 0],
    [w, 0],
    [w, w],
    [0, w],
  ] as [number, number][],
  ...(holes
    ? {
        holes: [
          [
            [w / 2 + 1, w / 2, 1],
            [w / 2 - 1, w / 2, 1],
          ] as [number, number, number][],
        ],
      }
    : {}),
  vector: [0, 0, h] as [number, number, number],
});
const graph: GeometryGraph = {
  nodes: {
    board: box(0, 10, 1.6, true),
    part: box(20, 4, 2),
    turned: {
      op: 'transform',
      input: 'part',
      rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1],
      translation: [0, 30, 0],
    },
    bad: { op: 'boolean', kind: 'cut', target: 'part', tools: ['part'] },
  },
};
const parts = [
  { node: 'board', name: 'Böard', color: '#1f6b3a' },
  { node: 'turned', name: "J8 'shell'", color: '#c9cacd' },
];

describe('STEP request (PB7c)', () => {
  it('TS-1947: checks the request: schema, names, colours, nodes; writes P21 strings', () => {
    expect(validateGeometry(graph, [], { schema: 'ap214', name: 'Board', parts })).toEqual([]);
    const issues = validateGeometry(graph, [], {
      schema: 'ap203' as never,
      name: '',
      parts: [
        { node: 'missing', name: 'x' },
        { node: 'board', name: 'y', color: 'green' },
      ],
    });
    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ['request-invalid', 'step.schema'],
      ['request-invalid', 'step.name'],
      ['node-missing', 'step.parts[0]'],
      ['request-invalid', 'step.parts[1].color'],
    ]);
    expect(
      validateGeometry(graph, [], { schema: 'ap242', name: 'B', parts: [] }).map((i) => i.path),
    ).toEqual(['step.parts']);
    expect(stepString("J8 'shell'")).toBe("'J8 ''shell'''");
    expect(stepString('a\\b')).toBe("'a\\\\b'");
    expect(stepString('Böard 基板')).toBe("'B\\X2\\00F6\\X0\\ard \\X2\\57FA677F\\X0\\'");
  });
});

const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('STEP with the development build (PB7c)', () => {
  let oc: OcModule;
  beforeAll(async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    oc = await factory({ wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`) });
  }, 120_000);

  it('TS-1948: writes AP214 and AP242 files with named, coloured products that read back', async () => {
    for (const schema of ['ap214', 'ap242'] as const) {
      const evaluation = await evaluateGeometry(oc, graph, [{ node: 'board', measure: true }], {
        step: { schema, name: 'Pi board', parts },
      });
      if (evaluation.status !== 'ok' || evaluation.step?.status !== 'ok')
        throw new Error(JSON.stringify(evaluation));
      const bytes = evaluation.step.bytes;
      const text = new TextDecoder().decode(bytes);
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(text).toMatch(
        schema === 'ap214' ? /AUTOMOTIVE_DESIGN/ : /AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/,
      );
      expect(text).toMatch(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
      // Every name is the one asked for, as a P21 string; no placeholder is left.
      expect(text).toContain("PRODUCT('Pi board','Pi board'");
      expect(text).toContain("PRODUCT('B\\X2\\00F6\\X0\\ard','B\\X2\\00F6\\X0\\ard'");
      expect(text).toContain("PRODUCT('J8 ''shell''','J8 ''shell'''");
      expect(text).not.toMatch(/GKSTEP/);
      expect(text).toMatch(/COLOUR_RGB/);
      // Read back with OCCT's STEP reader: two solids, the board's and the part's volumes.
      const path = `/readback-${schema}.step`;
      oc.FS.writeFile(path, bytes);
      const reader = new oc.STEPControl_Reader_1();
      expect(reader.ReadFile(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
      reader.TransferRoots(new oc.Message_ProgressRange_1());
      const shape = reader.OneShape();
      const volumes: number[] = [];
      const ex = new oc.TopExp_Explorer_2(
        shape,
        oc.TopAbs_ShapeEnum.TopAbs_SOLID,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      );
      for (; ex.More(); ex.Next()) {
        const props = new oc.GProp_GProps_1();
        oc.BRepGProp.VolumeProperties_1(ex.Current(), props, false, false, false);
        volumes.push(props.Mass());
        props.delete();
      }
      ex.delete();
      reader.delete();
      oc.FS.unlink(path);
      volumes.sort((a, b) => a - b);
      expect(volumes).toHaveLength(2);
      expect(volumes[0]).toBeCloseTo(4 * 4 * 2, 6);
      expect(volumes[1]).toBeCloseTo((100 - Math.PI) * 1.6, 6);
    }
    // One node asked for twice is two products, each with its own name and colour.
    const twice = await evaluateGeometry(oc, graph, [], {
      step: {
        schema: 'ap214',
        name: 'Two',
        parts: [
          { node: 'part', name: 'U1', color: '#ff0000' },
          { node: 'part', name: 'U2', color: '#0000ff' },
        ],
      },
    });
    if (twice.status !== 'ok' || twice.step?.status !== 'ok')
      throw new Error(JSON.stringify(twice));
    const twiceText = new TextDecoder().decode(twice.step.bytes);
    expect(twiceText).toContain("PRODUCT('U1','U1'");
    expect(twiceText).toContain("PRODUCT('U2','U2'");
    // OCCT writes pure red and blue as the predefined colours.
    expect(twiceText).toContain("DRAUGHTING_PRE_DEFINED_COLOUR('red')");
    expect(twiceText).toContain("DRAUGHTING_PRE_DEFINED_COLOUR('blue')");
    // A part whose node fails names it; the requests are still answered.
    const failed = await evaluateGeometry(oc, graph, [{ node: 'board', measure: true }], {
      step: { schema: 'ap214', name: 'x', parts: [{ node: 'bad', name: 'bad' }] },
    });
    expect(failed.status === 'ok' && failed.results[0]!.status).toBe('ok');
    expect(failed.status === 'ok' && failed.step).toMatchObject({ status: 'error', node: 'bad' });
  }, 120_000);
});
