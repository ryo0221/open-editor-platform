import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  assertCadOperation,
  cadEditorCommand,
  cadContentHash,
  cadTopologyLimits,
  duplicateClosureOf,
  edgeRef,
  f12Fillet,
  f12Holes,
  f12SlotArgs,
  polylineFillet,
  f13ShellDraft,
  formatFaceName,
  remapTopoName,
  sharedFaceName,
  blendFaceName,
  mm,
  validateCad,
  type CadDocument,
  type CadFeature,
  type CadTopologyRef,
} from './index';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const fillet = (doc: CadDocument) =>
  doc.features.find((f) => f.id === 'fillet') as Extract<CadFeature, { type: 'fillet' }>;
/** F12 with the fillet's args changed. */
const withFillet = (change: (args: { edges: unknown[]; radius: unknown }) => void) => {
  const doc = f12Fillet();
  change(fillet(doc).args as never);
  return doc;
};
const edges = '$.features[6].args.edges';

describe('stored topology references (R1c, CAD30)', () => {
  it('stores fillet references by name on the input feature, and validates F12', () => {
    const doc = f12Fillet();
    expect(validateCad(doc)).toEqual([]);
    expect(validateCad(f12Holes())).toEqual([]);
    const f = fillet(doc);
    expect(f.inputFeatureIds).toEqual(['cut-s-placement']);
    expect(f.args.edges.map((e) => e.name)).toContainEqual([['+y'], ['+z']]);
    // The fillet comes after the body's result and before a new placement.
    expect(doc.bodies.find((b) => b.id === 'part')!.resultFeatureId).toBe('fillet-placement');
  });

  it('refuses a vertex where a feature reads an edge: only connectors name vertices (R2b-2c)', () => {
    const vertex = withFillet((a) => {
      const e = a.edges[0] as { kind: string; name: unknown[] };
      e.kind = 'vertex';
      e.name = [['+y'], ['+z'], ['-x']];
    });
    expect(codes(vertex)).toContain(`reference-kind@${edges}[0].kind`);
  });

  it('refuses malformed references without evaluating them', () => {
    expect(codes(withFillet((a) => ((a.edges[0] as CadTopologyRef).featureId = 'block')))).toEqual([
      `reference-feature@${edges}[0].featureId`,
    ]);
    expect(codes(withFillet((a) => ((a.edges[0] as { kind: string }).kind = 'face')))).toEqual([
      `reference-kind@${edges}[0].kind`,
    ]);
    // An edge name lists its two faces sorted; one face, three faces or an unsorted pair is wrong.
    for (const name of [[['+z']], [['+z'], ['-x'], ['+x']], [['+z'], ['+x']], [['+x'], []]])
      expect(codes(withFillet((a) => ((a.edges[0] as { name: unknown }).name = name)))).toEqual([
        `reference-name@${edges}[0].name`,
      ]);
    // A segment past the name limits.
    const long = [['x'.repeat(cadTopologyLimits.nameChars + 1)], ['y']];
    expect(codes(withFillet((a) => ((a.edges[0] as { name: unknown }).name = long)))).toEqual([
      `reference-name@${edges}[0].name`,
    ]);
    expect(
      codes(withFillet((a) => ((a.edges[0] as { select: unknown }).select = { adjacent: [] }))),
    ).toEqual([`reference-select@${edges}[0].select.adjacent`]);
    expect(
      codes(
        withFillet(
          (a) =>
            ((a.edges[0] as CadTopologyRef).hint = {
              centroid: [0, 0, 0],
              normal: [0, 0, 2],
              size: 1,
            }),
        ),
      ),
    ).toEqual([`reference-hint@${edges}[0].hint.normal`]);
    expect(codes(withFillet((a) => a.edges.push(a.edges[0])))).toEqual([
      `reference-duplicate@${edges}`,
    ]);
    expect(codes(withFillet((a) => a.edges.splice(0)))).toEqual([`reference-count@${edges}`]);
    expect(
      codes(withFillet((a) => (a.edges = Array.from({ length: 257 }, () => a.edges[0])))),
    ).toContain(`reference-count@${edges}`);
    expect(codes(withFillet((a) => (a.radius = mm(0))))).toEqual([
      `dimension-range@$.features[6].args.radius`,
    ]);
  });

  it('counts references across the document: 4,096 pass, 4,097 do not', () => {
    const doc = f12Fillet();
    const base = fillet(doc);
    const ref = base.args.edges[0]!;
    const chain = (n: number, last: number) => {
      const copy = structuredClone(doc);
      const fillets: CadFeature[] = [];
      let input = base.inputFeatureIds[0];
      for (let i = 0; i < n; i++) {
        const id = `f${i}`;
        const count = i === n - 1 ? last : cadTopologyLimits.refsPerFeature;
        fillets.push({
          id,
          name: id,
          type: 'fillet',
          inputFeatureIds: [input],
          args: {
            radius: mm(1),
            edges: Array.from({ length: count }, (_, k) => ({
              ...ref,
              featureId: input,
              name: [['+z'], [`side:${k}`]],
            })),
          },
        });
        input = id;
      }
      const i = copy.features.findIndex((f) => f.id === 'fillet');
      copy.features.splice(i, 1, ...fillets);
      copy.features.find((f) => f.id === 'fillet-placement')!.inputFeatureIds = [input] as never;
      return copy;
    };
    expect(codes(chain(16, cadTopologyLimits.refsPerFeature))).toEqual([]);
    expect(codes(chain(17, 1))).toEqual(['limit-references@$.features']);
  });

  it('adds a detail feature only on an active body result', () => {
    const doc = f12Fillet();
    const f = structuredClone(fillet(doc));
    const op = (feature: unknown, bodyId = 'part') =>
      applyCadOperation(doc, {
        type: 'detailBody',
        bodyId,
        placementFeatureId: 'p2',
        feature: { ...(feature as CadFeature), id: 'f2' } as never,
      });
    // The body's result is now the fillet's placement; reading the earlier result is refused.
    expect(() => op(f)).toThrow('detail-input');
    const next = op({
      ...f,
      inputFeatureIds: ['fillet-placement'],
      args: {
        ...f.args,
        edges: f.args.edges.map((e) => ({ ...e, featureId: 'fillet-placement' })),
      },
    });
    expect(next.bodies.find((b) => b.id === 'part')!.resultFeatureId).toBe('p2');
    expect(() => op({ ...f, type: 'box' })).toThrow('detail-type');
    expect(() => op(f, 's')).toThrow('body-consumed');
  });

  it('combines several tools in one Boolean and consumes them all', () => {
    const doc = f12Holes();
    const holes = doc.features.find((f) => f.id === 'holes')!;
    expect(holes.inputFeatureIds).toEqual(['part-placement', 'a-placement', 'b-placement']);
    expect(doc.bodies.filter((b) => b.state === 'consumed').map((b) => b.id)).toEqual(['a', 'b']);
    // A Boolean lists each input once.
    const twice = structuredClone(doc);
    (twice.features.find((f) => f.id === 'holes')!.inputFeatureIds as string[]).push('a-placement');
    expect(codes(twice)).toContain('boolean-same-input@$.features[6].inputFeatureIds');
    const many = structuredClone(doc);
    many.features.find((f) => f.id === 'holes')!.inputFeatureIds = Array.from(
      { length: 258 },
      (_, i) => `x${i}`,
    ) as never;
    expect(codes(many)).toContain('feature-arity@$.features[6].inputFeatureIds');
    expect(() =>
      assertCadOperation({
        type: 'booleanBodies',
        targetId: 'part',
        toolId: 'a',
        toolIds: ['a'],
        mode: 'cut',
        booleanFeatureId: 'x',
        placementFeatureId: 'y',
      }),
    ).toThrow('operation-schema');
  });

  it('rebinds references with the upstream edit in one transaction', () => {
    const doc = f12Fillet();
    const left = edgeRef('cut-s-placement', ['+y'], ['+z'], [22.5, 60, 20], 45);
    const chosen = {
      ...left,
      select: { adjacent: [[['+z'], ['-x']]] as CadTopologyRef['name'][] },
    };
    const op = {
      type: 'rebindReferences' as const,
      edit: { type: 'updateFeature' as const, featureId: 'slot', args: f12SlotArgs('split') },
      bindings: [{ featureId: 'fillet', path: ['edges', 2], ref: chosen }],
    };
    const next = applyCadOperation(doc, op);
    expect(fillet(next).args.edges[2]).toEqual(chosen);
    expect(next.features.find((f) => f.id === 'slot')!.args).toEqual(f12SlotArgs('split'));
    // One command: one history entry, Undo restores both.
    const command = cadEditorCommand(op, {
      expectedHash: cadContentHash(doc),
      canEdit: () => true,
    });
    expect(command.label).toBe('Choose references again');
    // Only a stored reference of the same kind is replaced; nesting is refused.
    const bad =
      (path: (string | number)[], ref: unknown = chosen) =>
      () =>
        applyCadOperation(doc, {
          type: 'rebindReferences',
          bindings: [{ featureId: 'fillet', path, ref: ref as never }],
        });
    expect(bad(['radius'])).toThrow('rebind-path');
    expect(bad(['edges', 9])).toThrow('rebind-path');
    expect(bad(['edges', 0], { ...chosen, kind: 'face' })).toThrow('rebind-path');
    expect(() =>
      assertCadOperation({ type: 'rebindReferences', edit: op, bindings: op.bindings }),
    ).toThrow('operation-schema');
    // A rebound reference that does not fit the document is refused like any edit.
    expect(bad(['edges', 0], { ...chosen, featureId: 'block' })).toThrow('reference-feature');
  });

  it('reorders and removes Boolean tools in one edit; a removed tool is active again', () => {
    const doc = f12Holes();
    const holes = (d: CadDocument) => d.features.find((f) => f.id === 'holes')!;
    const set = (toolIds: string[]) =>
      applyCadOperation(doc, { type: 'setBooleanTools', featureId: 'holes', toolIds });
    const swapped = set(['b', 'a']);
    expect(validateCad(swapped)).toEqual([]);
    expect(holes(swapped).inputFeatureIds).toEqual([
      'part-placement',
      'b-placement',
      'a-placement',
    ]);
    const one = set(['a']);
    expect(validateCad(one)).toEqual([]);
    expect(holes(one).inputFeatureIds).toEqual(['part-placement', 'a-placement']);
    const { consumedByFeatureId: _, ...b } = doc.bodies.find((x) => x.id === 'b') as never as {
      consumedByFeatureId: string;
    } & Record<string, unknown>;
    expect(one.bodies.find((x) => x.id === 'b')).toStrictEqual({ ...b, state: 'active' });
    // The fillet still names hole a's rim: removing b leaves its reference as it was.
    expect(one.features.find((f) => f.id === 'rim')).toEqual(
      doc.features.find((f) => f.id === 'rim'),
    );
    for (const toolIds of [[], ['a', 'a'], ['part'], ['a', 'c']])
      expect(() => set(toolIds), JSON.stringify(toolIds)).toThrow('boolean-tools');
    expect(() =>
      applyCadOperation(doc, { type: 'setBooleanTools', featureId: 'rim', toolIds: ['a'] }),
    ).toThrow('boolean-feature');
    expect(() =>
      assertCadOperation({ type: 'setBooleanTools', featureId: 'holes', toolIds: [] }),
    ).toThrow('operation-schema');
    expect(
      cadEditorCommand(
        { type: 'setBooleanTools', featureId: 'holes', toolIds: ['a'] },
        { expectedHash: cadContentHash(doc), canEdit: () => true },
      ).label,
    ).toBe('Change Boolean tools');
  });

  it('renames the feature IDs inside duplicated references', () => {
    const doc = f12Holes();
    const { ids } = duplicateClosureOf(doc, ['part']);
    const idMap = Object.fromEntries(ids.map((id) => [id, `copy-${id}`]));
    const copy = applyCadOperation(doc, { type: 'duplicateClosure', bodyIds: ['part'], idMap });
    expect(validateCad(copy)).toEqual([]);
    const rim = copy.features.find((f) => f.id === 'copy-rim') as Extract<
      CadFeature,
      { type: 'fillet' }
    >;
    expect(rim.args.edges[0]!.featureId).toBe('copy-holes-placement');
    expect(rim.args.edges[0]!.name).toEqual([['+z'], ['tool:copy-a-placement', 'side']]);
  });

  it('renames polyline vertex IDs inside duplicated references', () => {
    const doc = polylineFillet();
    const { ids } = duplicateClosureOf(doc, ['slab']);
    const idMap = Object.fromEntries(ids.map((id) => [id, `copy-${id}`]));
    const copy = applyCadOperation(doc, { type: 'duplicateClosure', bodyIds: ['slab'], idMap });
    expect(validateCad(copy)).toEqual([]);
    const f = copy.features.find((x) => x.id === 'copy-round') as Extract<
      CadFeature,
      { type: 'fillet' }
    >;
    expect(f.args.edges[0]!.name).toEqual([['end'], ['side:v:copy-v0']]);
    // A recipe side name is never an ID, even when a copied vertex ID spells it.
    expect(remapTopoName([['end'], ['side:-v']], { '-v': 'copy--v' })).toEqual([
      ['end'],
      ['side:-v'],
    ]);
    expect(remapTopoName([['side:v:-v']], { '-v': 'copy--v' })).toEqual([['side:v:copy--v']]);
  });

  it('validates shell and draft references and their ranges (R1c, CAD32)', () => {
    const doc = f13ShellDraft();
    expect(validateCad(doc)).toEqual([]);
    const at = (id: string) => doc.features.findIndex((f) => f.id === id);
    const change = (id: string, edit: (a: Record<string, unknown>) => void) => {
      const copy = structuredClone(doc);
      edit(copy.features[at(id)]!.args as never);
      return codes(copy);
    };
    const shell = `$.features[${at('shell')}].args`;
    const draft = `$.features[${at('draft')}].args`;
    // A shell may leave no face open, and at most 64.
    expect(change('shell', (a) => (a.openFaces = []))).toEqual([]);
    expect(
      change('shell', (a) => {
        const one = (a.openFaces as CadTopologyRef[])[0]!;
        a.openFaces = Array.from({ length: 65 }, (_, i) => ({ ...one, name: [[`f${i}`]] }));
      }),
    ).toEqual([`reference-count@${shell}.openFaces`]);
    expect(change('shell', (a) => (a.side = 'both'))).toEqual([`shell-side@${shell}.side`]);
    expect(change('shell', (a) => ((a.openFaces as { kind: string }[])[0]!.kind = 'edge'))).toEqual(
      [`reference-kind@${shell}.openFaces[0].kind`],
    );
    // The draft angle is in (0, π/4], the pull direction a unit vector.
    expect(change('draft', (a) => (a.angle = { literalRad: Math.PI / 4 }))).toEqual([]);
    expect(change('draft', (a) => (a.angle = { literalRad: Math.PI / 4 + 1e-9 }))).toEqual([
      `draft-angle@${draft}.angle`,
    ]);
    // Zero is no angle at all (any angle's range is (0, 2π]).
    expect(change('draft', (a) => (a.angle = { literalRad: 0 }))).toEqual([
      `angle-range@${draft}.angle`,
    ]);
    expect(change('draft', (a) => (a.direction = [0, 0, 2]))).toEqual([
      `draft-direction@${draft}.direction`,
    ]);
    expect(change('draft', (a) => (a.faces = []))).toEqual([`reference-count@${draft}.faces`]);
  });

  it('formats a blend face by the edge it replaces', () => {
    expect(formatFaceName(blendFaceName([['+y'], ['+z']]))).toBe('blend:(+y | +z)');
    expect(formatFaceName(['tool:a', 'side'])).toBe('tool:a/side');
    const shared = sharedFaceName([
      ['tool:b', 'side'],
      ['tool:a', 'side'],
    ]);
    expect(formatFaceName(shared)).toBe('shared:(tool:a/side | tool:b/side)');
    // Duplication renames the IDs inside and sorts the names again.
    expect(remapTopoName([shared], { a: 'z', b: 'c' }).map(formatFaceName)).toEqual([
      'shared:(tool:c/side | tool:z/side)',
    ]);
  });
});
