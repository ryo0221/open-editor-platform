import { describe, expect, it } from 'vitest';
import { assertCadOperation } from './commands';
import { f02Plate, f26Panel } from './fixtures';
import { bodyPartContent, makePartRemoval } from './make-part';
import { identityQuaternion, position, type CadDocument } from './model';
import { applyCadOperation, cadContentHash, type CadOperation } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const error = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
};
const makePart = (doc: CadDocument, bodyId: string, content = bodyPartContent(doc, bodyId)) =>
  ({
    type: 'makePart',
    bodyId,
    part: {
      id: 'part-door',
      name: 'Door',
      source: {
        kind: 'version',
        artifactId: 'door-artifact',
        versionId: 'v1',
        contentHash: cadContentHash(content),
      },
      hint: {
        boundsMm: [
          [40, -40, 0],
          [60, -20, 0],
        ],
      },
    },
    component: {
      id: 'component-door',
      name: 'Door 1',
      partId: 'part-door',
      placement: { translation: position(0, 0, 0), rotation: identityQuaternion() },
      bom: 'include',
    },
  }) satisfies CadOperation;

describe('Make part (CR3e)', () => {
  it('copies the body closure into a part and replaces the body by a component at the origin', () => {
    // TS-1514, ST-257.
    const doc = f26Panel();
    const content = bodyPartContent(doc, 'door-body');
    expect(codes(content)).toEqual([]);
    expect(content.kernelProfile).toEqual(doc.kernelProfile);
    expect(content.bodies.map((b) => b.id)).toEqual(['door-body']);
    // The door reads the skin it is cut from, so the part holds that history too.
    expect(content.features.map((f) => f.id)).toEqual(
      doc.features
        .map((f) => f.id)
        .filter((id) => ['door', 'door-body-placement'].includes(id) || id.startsWith('panel')),
    );
    expect(content.sketches.map((s) => s.id).sort()).toEqual(['cutter', 'edge-line']);
    expect(content.components).toEqual([]);

    // The skin keeps its trim; only the door and its placement leave.
    expect(makePartRemoval(doc, 'door-body')).toEqual({
      profiles: new Set(),
      sketches: new Set(),
      features: new Set(['door', 'door-body-placement']),
      bodies: new Set(['door-body']),
    });
    const op = makePart(doc, 'door-body');
    assertCadOperation(op);
    const next = applyCadOperation(doc, op);
    expect(codes(next)).toEqual([]);
    expect(next.bodies.map((b) => b.id)).toEqual(['panel-body']);
    expect(next.features.some((f) => f.id === 'door')).toBe(false);
    expect(next.sketches.map((s) => s.id).sort()).toEqual(['cutter', 'edge-line']);
    expect(next.parts.map((p) => p.id)).toEqual(['part-door']);
    expect(next.components.map((c) => [c.id, c.partId])).toEqual([['component-door', 'part-door']]);
    expect(Object.keys(next.solvedPoses)).toEqual(['component-door']);
  });

  it('moves a lone body out whole and refuses consumed bodies, dependents and mismatches', () => {
    // TS-1515, ST-257.
    const plate = f02Plate();
    const bodyId = plate.bodies[0]!.id;
    const removal = makePartRemoval(plate, bodyId);
    expect([...removal.features].sort()).toEqual(plate.features.map((f) => f.id).sort());
    const next = applyCadOperation(plate, makePart(plate, bodyId));
    expect(codes(next)).toEqual([]);
    expect(next.features).toEqual([]);
    expect(next.bodies).toEqual([]);
    expect(next.parameters).toEqual(plate.parameters);

    expect(error(() => bodyPartContent(plate, 'nope'))).toBe('target-missing');
    const consumed = structuredClone(plate);
    consumed.bodies[0] = {
      ...consumed.bodies[0]!,
      state: 'consumed',
      consumedByFeatureId: consumed.features[0]!.id,
    } as CadDocument['bodies'][number];
    expect(error(() => bodyPartContent(consumed, bodyId))).toBe('body-consumed');
    const textured = structuredClone(plate);
    textured.bodies[0]!.appearance = {
      ...textured.bodies[0]!.appearance,
      textures: { maps: { baseColor: 'tex' } },
    } as unknown as CadDocument['bodies'][number]['appearance'];
    expect(error(() => bodyPartContent(textured, bodyId))).toBe('make-part-textures');
    // A feature left without a body that reads the door still needs it.
    const panel = f26Panel();
    const door = panel.features.find((f) => f.id === 'door')!;
    panel.features.push({
      ...door,
      id: 'door-again',
      args: { ...door.args, source: { featureId: 'door-body-placement' } },
    } as typeof door);
    expect(error(() => makePartRemoval(panel, 'door-body'))).toBe('make-part-has-dependents');
    const op = makePart(plate, bodyId);
    expect(
      error(() =>
        applyCadOperation(plate, { ...op, component: { ...op.component, partId: 'other' } }),
      ),
    ).toBe('make-part-component');
  });
});
