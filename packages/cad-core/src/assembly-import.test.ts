import { describe, expect, it } from 'vitest';
import { cadQuantityRows } from './quantity';
import { expandAssembly, type CadSolvedPose } from './assembly';
import {
  cadStepImportLimits,
  importedPartDocument,
  stepImportPlan,
  stepName,
  type CadStepAssemblyRead,
} from './assembly-import';
import { fixtureKernel } from './fixtures';
import { cadAssetMediaTypes, emptyCad, type CadAssetRef } from './model';
import { applyCadOperation, cadContentHash } from './operations';
import { validateCad } from './validation';

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const ref = (kind: CadAssetRef['kind'], c: string): CadAssetRef => ({
  id: 'x',
  kind,
  sha256: sha(c),
  byteLength: 10,
  mediaType: cadAssetMediaTypes[kind],
});
const pose = (x: number, rotation: CadSolvedPose['rotation'] = [0, 0, 0, 1]): CadSolvedPose => ({
  translationMm: [x, 0, 0],
  rotation,
});
const shape = (name: string, c: string, product = name): CadStepAssemblyRead['shapes'][number] => ({
  name,
  product: { id: `${product}-1`, name: product, description: `${product} as read` },
  kind: 'solid',
  brep: { sha256: sha(c), byteLength: 10 },
  boundsMm: [
    [0, 0, 0],
    [10, 10, 10],
  ],
});
/** A cart: two wheels inside a sub-assembly and one plate at the root. */
const read = (): CadStepAssemblyRead => ({
  shapes: [shape('Plate', 'a'), shape('Wheel', 'b')],
  instances: [
    { shape: 0, path: ['Plate'], pose: pose(0) },
    { shape: 1, path: ['Axle', 'Wheel 1'], pose: pose(10, [0, 0, 1, 0]) },
    { shape: 1, path: ['Axle', 'Wheel 2'], pose: pose(20) },
  ],
  skipped: ['Empty'],
});
const conversion = { sourceUnit: 'in' as const, scaleToMm: 25.4 };
const plan = (r = read()) => {
  let n = 0;
  return stepImportPlan(
    fixtureKernel,
    r,
    {
      source: ref('source-step', 'c'),
      breps: r.shapes.map((s) => ref('normalized-brep', s.brep.sha256.slice(-1))),
    },
    conversion,
    (prefix) => `${prefix}-${++n}`,
  );
};

describe('STEP AP242 assembly import plan (R2b-5, R2b-U7)', () => {
  it('makes one imported part per shape and one fixed component per instance', () => {
    const p = plan();
    if (p.status !== 'ok') throw new Error(p.code);
    expect(p.parts.map((x) => x.name)).toEqual(['Plate', 'Wheel']);
    expect(p.parts[1]!.source).toEqual({
      kind: 'imported',
      contentHash: cadContentHash(p.versions[1]!),
      sourceAssetId: 'source',
      brepAssetId: 'brep',
      stepProduct: { id: 'Wheel-1', name: 'Wheel', description: 'Wheel as read' },
    });
    // The flattened path stays in the name; the placement is the file's.
    expect(p.components.map((c) => [c.name, c.partId])).toEqual([
      ['Plate', 'part-1'],
      ['Axle / Wheel 1', 'part-2'],
      ['Axle / Wheel 2', 'part-2'],
    ]);
    expect(p.components[1]!.placement!.rotation).toEqual([0, 0, 1, 0]);
    expect(p.components.every((c) => c.bom === 'include')).toBe(true);
    // Each part document is a history-less imported body with its product's properties.
    const wheel = p.versions[1]!;
    expect(validateCad(wheel)).toEqual([]);
    expect(wheel.features.map((f) => f.type)).toEqual(['imported', 'transform']);
    expect(wheel.assets.map((a) => [a.id, a.kind, a.sha256])).toEqual([
      ['source', 'source-step', sha('c')],
      ['brep', 'normalized-brep', sha('b')],
    ]);
    expect(wheel.features[0]!.args).toMatchObject({ sourceUnit: 'in', scaleToMm: 25.4 });
    expect(wheel.partProperties).toMatchObject({
      partNumber: 'Wheel-1',
      description: 'Wheel as read',
    });
    // One edit places them all in an empty document, and the closure resolves every part.
    const doc = applyCadOperation(emptyCad(fixtureKernel), {
      type: 'insertComponents',
      parts: p.parts,
      components: p.components,
    });
    expect(validateCad(doc)).toEqual([]);
    const byHash = new Map(p.versions.map((v) => [cadContentHash(v), v]));
    expect(() => cadQuantityRows('estimate-source', doc, (h) => byHash.get(h))).toThrow(
      'quantity-imported-part-unsupported',
    );
    const reach = expandAssembly(doc, (h) => byHash.get(h));
    expect(reach.missing.size).toBe(0);
    expect(reach.versions.size).toBe(2);
  });

  it('keeps one shape one content hash, and identical shapes one part', () => {
    const assets = { source: ref('source-step', 'c'), brep: ref('normalized-brep', 'b') };
    const a = importedPartDocument(fixtureKernel, shape('Wheel', 'b'), assets, conversion);
    const b = importedPartDocument(fixtureKernel, shape('Wheel', 'b'), assets, conversion);
    expect(cadContentHash(a)).toBe(cadContentHash(b));
    const other = importedPartDocument(
      fixtureKernel,
      shape('Wheel', 'b', 'Rim'),
      assets,
      conversion,
    );
    expect(cadContentHash(other)).not.toBe(cadContentHash(a));
    const r = read();
    r.shapes.push(shape('Wheel', 'b'));
    r.instances.push({ shape: 2, path: ['Wheel 3'], pose: pose(30) });
    const p = plan(r);
    if (p.status !== 'ok') throw new Error(p.code);
    expect(p.parts).toHaveLength(2);
    expect(p.versions).toHaveLength(2);
    expect(p.components.at(-1)!.partId).toBe(p.parts[1]!.id);
  });

  it('names within the document limits and refuses an empty or too large assembly', () => {
    expect(stepName('Bolt\u0000M8\n', 'x')).toBe('Bolt M8');
    expect(stepName('  ', 'STEP')).toBe('STEP');
    expect([...stepName('あ'.repeat(500), '')].length).toBeLessThan(500);
    // A split shape's number stays whole at the end of a long name.
    const long = stepName('あ'.repeat(500), 'STEP', ' (2)');
    expect(long.endsWith('あ (2)')).toBe(true);
    expect([...long].length).toBe([...stepName('あ'.repeat(500), '')].length);
    // A raw name the kernel read becomes a valid part document.
    const raw = { ...shape('x', 'b'), name: `Wheel\u0007${'w'.repeat(500)}` };
    const assets = { source: ref('source-step', 'c'), brep: ref('normalized-brep', 'b') };
    const doc = importedPartDocument(fixtureKernel, raw, assets, conversion);
    expect(validateCad(doc)).toEqual([]);
    expect(doc.bodies[0]!.name.startsWith('Wheel w')).toBe(true);
    expect(plan({ ...read(), instances: [] })).toEqual({
      status: 'refused',
      code: 'step-assembly-empty',
    });
    const many = read();
    many.instances = Array.from({ length: cadStepImportLimits.components + 1 }, (_, i) => ({
      shape: 0,
      path: [`Plate ${i}`],
      pose: pose(i),
    }));
    expect(plan(many)).toEqual({ status: 'refused', code: 'step-instance-limit' });
    many.instances.pop();
    expect(plan(many).status).toBe('ok');
  });

  it('refuses an imported source with a wrong hash, a missing product or a duplicate', () => {
    const p = plan();
    if (p.status !== 'ok') throw new Error(p.code);
    const doc = applyCadOperation(emptyCad(fixtureKernel), {
      type: 'insertComponents',
      parts: p.parts,
      components: p.components,
    });
    const codes = (d: unknown) => validateCad(d).map((x) => x.code);
    const bad = structuredClone(doc) as unknown as { parts: { source: Record<string, unknown> }[] };
    bad.parts[0]!.source.contentHash = 'sha256:abc';
    expect(codes(bad)).toContain('part-source-hash');
    const noProduct = structuredClone(doc) as unknown as typeof bad;
    delete noProduct.parts[0]!.source.stepProduct;
    expect(codes(noProduct).length).toBeGreaterThan(0);
    const twice = structuredClone(doc) as unknown as typeof bad;
    twice.parts[1]!.source = { ...twice.parts[0]!.source };
    expect(codes(twice)).toContain('part-source-duplicate');
  });
});
