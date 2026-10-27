import { describe, expect, it } from 'vitest';
import { f42Airliner } from './complex-fixtures';
import { f15Loft, f15Sweep } from './fixtures';
import { dependencyOrder, featureReads } from './graph';
import { applyCadOperation, duplicateClosureOf } from './operations';
import { cadLoftSections, mm, type CadDocument, type CadFeature } from './model';
import { sketchDefaultPath, sketchPath } from './sketch';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
/** `doc` with its single loft or sweep's args changed by `change`. */
function withArgs(doc: CadDocument, change: (args: Record<string, unknown>) => void): CadDocument {
  const out = structuredClone(doc) as CadDocument;
  change(out.features.find((f) => f.type === 'loft' || f.type === 'sweep')!.args as never);
  return out;
}

describe('loft and sweep in the model (R1e, F15)', () => {
  it('accepts F15', () => {
    expect(codes(f15Loft())).toEqual([]);
    expect(codes(f15Loft('square'))).toEqual([]);
    expect(codes(f15Sweep())).toEqual([]);
    expect(codes(f15Sweep('fixed'))).toEqual([]);
  });

  it('refuses a loft with too few or too many sections, one sketch twice or a hole', () => {
    const loft = f15Loft();
    const sections = (n: number) =>
      withArgs(loft, (a) => {
        const s = a.sections as unknown[];
        a.sections = Array.from({ length: n }, (_, i) => s[i % 2]);
      });
    expect(codes(sections(1))).toEqual(['loft-sections@$.features[0].args.sections']);
    expect(codes(sections(cadLoftSections + 1))).toEqual([
      'limit-loft-sections@$.features[0].args.sections',
    ]);
    expect(codes(sections(3))).toEqual([
      'loft-same-sketch@$.features[0].args.sections[2].sketchId',
    ]);
    expect(codes(withArgs(loft, (a) => (a.ruled = 'yes')))).toEqual([
      'loft-ruled@$.features[0].args.ruled',
    ]);
    // The square with the circle as a hole: a region, but not a section.
    const holed = structuredClone(loft) as CadDocument;
    holed.sketches[0]!.entities.push(
      { type: 'point', id: 'o' },
      { type: 'circle', id: 'c0', center: 'o' },
    );
    Object.assign(holed.sketches[0]!.solved, { o: [0, 0], c0: [5, 0] });
    (
      holed.features[0]!.args as { sections: { region: { holes: string[][] } }[] }
    ).sections[0]!.region.holes.push(['c0']);
    expect(codes(holed)).toEqual(['section-holes@$.features[0].args.sections[0].region.holes']);
  });

  it('takes as many sections as the limit, each its own sketch (CAD36)', () => {
    const loft = f15Loft('square');
    const stack = (n: number) => {
      const out = structuredClone(loft) as CadDocument;
      const base = out.sketches[0]!;
      out.sketches = Array.from({ length: n }, (_, i) => ({
        ...structuredClone(base),
        id: `s${i}`,
        name: `s${i}`,
        plane: { ...base.plane, origin: [mm(0), mm(0), mm(i * 5)] },
      }));
      (out.features[0]!.args as { sections: unknown[] }).sections = out.sketches.map((k) => ({
        sketchId: k.id,
        region: { outer: ['l0', 'l1', 'l2', 'l3'], holes: [] },
      }));
      return out;
    };
    expect(codes(stack(cadLoftSections))).toEqual([]);
    expect(codes(stack(cadLoftSections + 1))).toEqual([
      'limit-loft-sections@$.features[0].args.sections',
    ]);
  });

  it('refuses a sweep path that is not one open chain of lines and arcs', () => {
    const sweep = f15Sweep();
    const path = (elements: string[]) =>
      withArgs(sweep, (a) => ((a.path as { elements: string[] }).elements = elements));
    // Either order of a chain is one path.
    expect(codes(path(['a0', 'l0']))).toEqual([]);
    expect(codes(path(['l0', 'l0']))).toEqual([
      'sweep-path-element@$.features[0].args.path.elements[1]',
    ]);
    expect(codes(path(['p0']))).toEqual(['sweep-path-element@$.features[0].args.path.elements[0]']);
    expect(codes(path([]))).toEqual(['sweep-path@$.features[0].args.path.elements']);
    expect(
      codes(withArgs(sweep, (a) => ((a.path as { sketchId: string }).sketchId = 'pipe-profile'))),
    ).toContain('sweep-same-sketch@$.features[0].args.path.sketchId');
    expect(codes(withArgs(sweep, (a) => (a.orientation = 'twist')))).toEqual([
      'sweep-orientation@$.features[0].args.orientation',
    ]);
    // A gap, a closed chain and a chain that crosses itself, on the path sketch itself.
    const s = structuredClone(sweep.sketches[1]!);
    s.entities.push(
      { type: 'point', id: 'q0' },
      { type: 'point', id: 'q1' },
      { type: 'line', id: 'gap', start: 'q0', end: 'q1' },
      { type: 'line', id: 'back', start: 'p2', end: 'p0' },
      { type: 'line', id: 'cross', start: 'p2', end: 'q1' },
    );
    Object.assign(s.solved, { q0: [100, 0], q1: [20, -10] });
    expect(sketchPath(s, ['l0', 'gap'])).toEqual({ code: 'sweep-path-gap', path: '[1]' });
    expect(sketchPath(s, ['l0', 'a0', 'back'])).toEqual({ code: 'sweep-path-closed', path: '' });
    expect(sketchPath(s, ['l0', 'a0', 'cross'])).toEqual({
      code: 'sweep-path-self-intersection',
      path: '[2]',
    });
    expect(sketchPath(s, ['a0'])).toMatchObject({ forward: [true] });
    expect(sketchPath(s, ['a0', 'l0'])).toMatchObject({ forward: [false, false] });
  });

  it('reads every sketch it sweeps: order, deletion and duplication follow them', () => {
    const doc = f15Sweep();
    const sweep = doc.features[0] as CadFeature;
    expect(featureReads(sweep).sketches).toEqual(['pipe-profile', 'pipe-path']);
    const order = dependencyOrder(doc);
    if (!('order' in order)) throw new Error('cycle');
    const at = (id: string) => order.order.indexOf(id);
    expect(at('pipe-profile')).toBeLessThan(at('pipe-sweep'));
    expect(at('pipe-path')).toBeLessThan(at('pipe-sweep'));
    const loft = f15Loft();
    expect(featureReads(loft.features[0]!).sketches).toEqual(['loft-base', 'loft-top']);
    // A sketch a loft reads is not deleted alone; with cascade the loft and its body go too.
    expect(() =>
      applyCadOperation(loft, { type: 'deleteClosure', ids: ['loft-top'], cascade: false }),
    ).toThrow('delete-has-dependents');
    const cascaded = applyCadOperation(loft, {
      type: 'deleteClosure',
      ids: ['loft-top'],
      cascade: true,
    });
    expect(cascaded.sketches.map((s) => s.id)).toEqual(['loft-base']);
    expect(cascaded.features).toEqual([]);
    const { ids } = duplicateClosureOf(doc, ['pipe']);
    expect(ids).toEqual(expect.arrayContaining(['pipe-profile', 'pipe-path', 'pipe-sweep']));
    const copy = applyCadOperation(doc, {
      type: 'duplicateClosure',
      bodyIds: ['pipe'],
      idMap: Object.fromEntries(ids.map((id) => [id, `${id}-2`])),
    });
    expect(validateCad(copy)).toEqual([]);
    expect(copy.features[2]!.args).toMatchObject({
      profile: { sketchId: 'pipe-profile-2' },
      path: { sketchId: 'pipe-path-2', elements: ['l0', 'a0'] },
    });
  });

  it('finds the open chain a sketch draws, for a sweep made from the Surface', () => {
    const [profile, path] = f15Sweep().sketches;
    expect(sketchDefaultPath(path!)).toEqual(['l0', 'a0']);
    // Listed the other way round, the chain still starts at an end.
    const turned = { ...path!, entities: [...path!.entities].reverse() };
    expect(sketchDefaultPath(turned)).toEqual(['a0', 'l0']);
    expect(sketchDefaultPath(profile!)).toBeUndefined();
    expect(sketchDefaultPath(f15Loft().sketches[0]!)).toBeUndefined();
    const branched = structuredClone(path!);
    branched.entities.push(
      { type: 'point', id: 'x' },
      { type: 'line', id: 'lx', start: 'p1', end: 'x' },
    );
    branched.solved.x = [50, -20];
    expect(sketchDefaultPath(branched)).toBeUndefined();
  });
});

describe('derived loft sections (K6, CM-7a)', () => {
  /** F15's loft with a third section: the first one moved along its normal and scaled. */
  const derived = (section: Record<string, unknown> = {}) =>
    withArgs(f15Loft(), (a) => {
      (a.sections as unknown[]).push({
        derivedFrom: 0,
        offset: [{ literalMm: 0 }, { literalMm: 0 }, { literalMm: -40 }],
        scale: { literal: 0.5 },
        angle: { literalRad: 0.2 },
        ...section,
      });
    });
  const at = '$.features[0].args.sections[2]';

  it('accepts sections derived from an earlier sketch section, and the airliner wing', () => {
    expect(codes(derived())).toEqual([]);
    expect(codes(derived({ derivedFrom: 1 }))).toEqual([]);
    expect(codes(f42Airliner(undefined, { derived: true }))).toEqual([]);
  });

  it('refuses a source that is not an earlier sketch section, a bad scale or a stray key', () => {
    for (const from of [2, 3, -1, 0.5, '0'])
      expect(codes(derived({ derivedFrom: from }))).toEqual([
        `derived-section-source@${at}.derivedFrom`,
      ]);
    // Derived from a derived section.
    const chained = withArgs(derived(), (a) => {
      const s = a.sections as Record<string, unknown>[];
      s.push({ ...s[2], derivedFrom: 2 });
    });
    expect(codes(chained)).toEqual([
      'derived-section-source@$.features[0].args.sections[3].derivedFrom',
    ]);
    for (const scale of [{ literal: 0 }, { literal: 1001 }, { literal: 'x' }, 2])
      expect(codes(derived({ scale }))).toEqual([`derived-section-scale@${at}.scale`]);
    expect(codes(derived({ scale: { expression: { postfix: [{ number: 0.0001 }] } } }))).toEqual([
      `derived-section-scale@${at}.scale`,
    ]);
    expect(
      codes(
        derived({
          scale: {
            expression: { postfix: [{ number: 2 }, { number: 0.25 }, { operator: 'mul' }] },
          },
        }),
      ),
    ).toEqual([]);
    expect(codes(derived({ twist: 1 }))).toEqual([`unknown-field@${at}.twist`]);
    expect(codes(derived({ offset: [{ literalMm: 0 }] }))).toEqual([`position@${at}.offset`]);
  });

  it('reads the parameters its offset, scale and twist name', () => {
    const doc = f42Airliner(undefined, { derived: true });
    const span = doc.parameters.find((p) => p.name === 'Half span')!.id;
    const loft = doc.features.find(
      (f) =>
        f.type === 'loft' &&
        (f.args.sections as unknown[]).some((x) => 'derivedFrom' in (x as object)),
    )!;
    expect(featureReads(loft).parameters).toContain(span);
    // Its sketches are the root's only.
    expect(featureReads(loft).sketches).toHaveLength(1);
  });
});
