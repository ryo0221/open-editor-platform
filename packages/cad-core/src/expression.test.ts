import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  assertCadOperation,
  cadContentHash,
  cadEditorCommand,
  cadExpressionLimits,
  dependencyClosure,
  emptyCad,
  duplicateClosureOf,
  evaluateExpression,
  f02Plate,
  f10Expressions,
  fixtureExpression,
  formatExpression,
  parameterValues,
  parseExpression,
  resolvePosition,
  validateCad,
  type CadDocument,
  type CadExpression,
  type CadOperation,
  type CadParameter,
} from './index';
import { cadJsonShape } from './validation';

type Loose = ReturnType<typeof JSON.parse>;
const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const diagnostics = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const mutate = (doc: CadDocument, edit: (d: Loose) => void) => {
  const copy: Loose = structuredClone(doc);
  edit(copy);
  return copy;
};
const value = (doc: CadDocument, id: string) => parameterValues(doc).get(id)?.value;
const ids = ['W', 'H', 'T', 'm', 'n', 'pitch', 'a'];
const expr = (text: string) => fixtureExpression(text, ids);
const params = new Map([
  ['W', { type: 'length' as const, value: 100 }],
  ['a', { type: 'angle' as const, value: Math.PI / 6 }],
  ['n', { type: 'count' as const, value: 4 }],
]);
const evaluate = (text: string) => evaluateExpression(expr(text), params);
const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'no-error';
};
/** A balanced sum of `leaves` × 1mm: `2 × leaves − 1` nodes. */
const balanced = (leaves: number): CadExpression => {
  const build = (n: number): CadExpression['postfix'] =>
    n === 1
      ? [{ number: 1, unit: 'mm' }]
      : [...build(Math.ceil(n / 2)), ...build(Math.floor(n / 2)), { operator: 'add' }];
  return { postfix: build(leaves) };
};
const withLength = (doc: CadDocument, e: unknown) =>
  mutate(doc, (d) => {
    const hole = d.features.find((f: Loose) => f.id === 'hole-cylinder');
    hole.args.radius = { expression: e };
  });
const exec = (s: EditorSession<CadDocument>, op: CadOperation) =>
  s.execute(cadEditorCommand(op, { expectedHash: cadContentHash(s.content), canEdit: () => true }));

describe('schema 2 expressions (F10, CAD27)', () => {
  it('evaluates F10: T = W / 20 and the pitch (W − 2 × m) / (n − 1)', () => {
    const doc = f10Expressions();
    expect(validateCad(doc)).toEqual([]);
    expect(value(doc, 'T')).toBe(5);
    expect(value(doc, 'pitch')).toBe(80 / 3);
    const hole = doc.features.find((f) => f.id === 'hole-cylinder')!;
    if (hole.type !== 'cylinder') throw new Error('fixture');
    expect(resolvePosition(hole.args.origin, parameterValues(doc))[0]).toBe(50);
    const wider = applyCadOperation(doc, { type: 'setParameter', parameterId: 'W', value: 120 });
    expect([value(wider, 'T'), value(wider, 'pitch')]).toEqual([6, 100 / 3]);
  });

  it('parses units, Unicode operators, functions and precedence', () => {
    expect(evaluate('2cm + 3mm')).toEqual({ type: 'length', value: 23 });
    expect(evaluate('1in')).toEqual({ type: 'length', value: 25.4 });
    expect(evaluate('1m − 1cm')).toEqual({ type: 'length', value: 990 });
    expect(evaluate('90deg')).toEqual({ type: 'angle', value: Math.PI / 2 });
    expect(evaluate('2 + 3 × 4 ÷ 2')).toEqual({ type: 'scalar', value: 8 });
    expect(evaluate('-(2 - 5) * W')).toEqual({ type: 'length', value: 300 });
    expect(evaluate('W / (n - 1)').value).toBe(100 / 3);
    expect(evaluate('min(W, 3cm)').value).toBe(30);
    expect(evaluate('max(W, 3cm)').value).toBe(100);
    expect(evaluate('abs(-W)').value).toBe(100);
    expect(evaluate('sqrt(16)').value).toBe(4);
    expect(evaluate('sin(a)').value).toBe(Math.sin(Math.PI / 6));
    expect(evaluate('atan2(W, W)')).toEqual({ type: 'angle', value: Math.PI / 4 });
    expect(evaluate('pi * 2').value).toBe(2 * Math.PI);
    expect(evaluate('W / W')).toEqual({ type: 'scalar', value: 1 });
    // A unit belongs to the number it touches: `2 m` is a syntax error, `2 × m` a product.
    expect(parseExpression('2 m', () => 'm')).toEqual({
      error: { code: 'expression-syntax', at: 2 },
    });
  });

  it('reports parse errors with their position and leaves names to the lookup', () => {
    const look = (name: string) => (name === 'W' ? 'W' : name === 'dup' ? null : undefined);
    expect(parseExpression('W +', look)).toEqual({ error: { code: 'expression-syntax', at: 3 } });
    expect(parseExpression('W + X', look)).toEqual({
      error: { code: 'expression-name-unknown', at: 4 },
    });
    expect(parseExpression('dup', look)).toEqual({
      error: { code: 'expression-name-ambiguous', at: 0 },
    });
    expect(parseExpression('W $ 2', look)).toEqual({ error: { code: 'expression-syntax', at: 2 } });
    expect(parseExpression('sin(W', look)).toEqual({ error: { code: 'expression-syntax', at: 5 } });
    expect(
      parseExpression('{wall thickness}', (n) => (n === 'wall thickness' ? 'p1' : undefined)),
    ).toEqual({
      expression: { postfix: [{ parameterId: 'p1' }] },
    });
  });

  it('formats back to text that parses to the same value', () => {
    const names: Record<string, string> = { W: 'Width', m: 'm', n: 'wall count', sin: 'x' };
    const byName = (s: string) => Object.keys(names).find((k) => names[k] === s);
    for (const text of [
      '(W − 2 × m) / (n − 1)',
      'W - (m - W)',
      'W / (W / 2)',
      '-(W + m) * 2',
      'atan2(W, m) + 90deg',
      '1.5e3mm + 0.25in',
    ]) {
      const e = expr(text);
      const shown = formatExpression(e, (id) => names[id] ?? id);
      const back = parseExpression(shown, byName);
      if ('error' in back) throw new Error(`${shown}: ${back.error.code}`);
      const p = new Map([
        ['W', { type: 'length' as const, value: 7 }],
        ['m', { type: 'length' as const, value: 3 }],
        ['n', { type: 'count' as const, value: 5 }],
      ]);
      expect(evaluateExpression(back.expression, p)).toEqual(evaluateExpression(e, p));
    }
    // Names that are not plain identifiers, or that collide with a function, are braced.
    expect(formatExpression(expr('n + W'), (id) => names[id])).toBe('{wall count} + Width');
    expect(formatExpression({ postfix: [{ parameterId: 'sin' }] }, (id) => names[id])).toBe('x');
    expect(formatExpression({ postfix: [{ parameterId: 'q' }] }, () => 'sin')).toBe('{sin}');
  });

  it('refuses type errors, division by zero, domain errors and non-finite results', () => {
    expect(errorOf(() => evaluate('W + a'))).toBe('expression-type');
    expect(errorOf(() => evaluate('W * W'))).toBe('expression-type');
    expect(errorOf(() => evaluate('a * a'))).toBe('expression-type');
    expect(errorOf(() => evaluate('sin(W)'))).toBe('expression-type');
    expect(errorOf(() => evaluate('sqrt(W)'))).toBe('expression-type');
    expect(errorOf(() => evaluate('2 / W'))).toBe('expression-type');
    expect(errorOf(() => evaluate('W / a'))).toBe('expression-type');
    expect(errorOf(() => evaluate('W / (n - 4)'))).toBe('expression-division-by-zero');
    expect(errorOf(() => evaluate('sqrt(-1)'))).toBe('expression-domain');
    expect(errorOf(() => evaluate('atan2(0, 0)'))).toBe('expression-domain');
    expect(errorOf(() => evaluate('1e308 * 10'))).toBe('expression-non-finite');
    expect(evaluate('-0 * W')).toEqual({ type: 'length', value: 0 });
    expect(Object.is(evaluate('-0 * W').value, 0)).toBe(true);
  });

  it('validates uses: dimension type and range, parameter types and node paths', () => {
    const doc = f10Expressions();
    expect(diagnostics(withLength(doc, expr('90deg')))).toEqual([
      'expression-type@$.features[1].args.radius.expression',
    ]);
    expect(codes(withLength(doc, expr('W - W')))).toEqual(['dimension-range']);
    expect(
      diagnostics(
        withLength(doc, { postfix: [{ number: 1 }, { parameterId: 'nope' }, { operator: 'add' }] }),
      ),
    ).toEqual(['parameter-missing@$.features[1].args.radius.expression.postfix[1]']);
    expect(codes(withLength(doc, { postfix: [{ number: 1 }, { operator: 'add' }] }))).toEqual([
      'expression-stack',
    ]);
    expect(codes(withLength(doc, { postfix: [{ number: 1 }, { number: 2 }] }))).toEqual([
      'expression-stack',
    ]);
    expect(codes(withLength(doc, { postfix: [] }))).toEqual(['expression-empty']);
    expect(codes(withLength(doc, { postfix: [{ number: 1, unit: 'ft' }] }))).toEqual([
      'expression-node',
    ]);
    expect(codes(withLength(doc, { postfix: [{ function: 'eval' }] }))).toEqual([
      'expression-node',
    ]);
    expect(codes(withLength(doc, { postfix: [{ number: 1, extra: 1 }] }))).toEqual([
      'expression-node',
    ]);
    expect(codes(withLength(doc, { source: 'W / 2' }))).toEqual(['expression']);
    // A parameter's expression must yield its own type; counts are positive integers.
    const typed = (p: Partial<CadParameter> & Loose) =>
      codes(mutate(doc, (d) => d.parameters.push({ id: 'x', name: 'x', ...p })));
    expect(typed({ type: 'angle', expression: expr('W') })).toEqual(['expression-type']);
    expect(typed({ type: 'count', expression: expr('W / W + 1') })).toEqual([]);
    expect(typed({ type: 'count', expression: expr('n / 3') })).toEqual(['count-range']);
    expect(typed({ type: 'count', value: 0 })).toEqual(['count-range']);
    expect(typed({ type: 'count', value: cadExpressionLimits.countMax })).toEqual([]);
    expect(typed({ type: 'count', value: cadExpressionLimits.countMax + 1 })).toEqual([
      'count-range',
    ]);
    expect(typed({ type: 'length', expression: expr('W'), value: 1 })).toEqual(['unknown-field']);
    expect(typed({ type: 'length', expression: expr('W * 1e5') })).toEqual(['coordinate-range']);
  });

  it('rejects parameter cycles and reports parameters that read a broken one', () => {
    const doc = f10Expressions();
    const self = mutate(doc, (d) => {
      delete d.parameters[0].value;
      d.parameters[0].expression = expr('W + 1mm');
    });
    expect(diagnostics(self)).toContain('parameter-cycle@$.parameters[0].expression');
    const loop = mutate(doc, (d) => {
      delete d.parameters[0].value;
      d.parameters[0].expression = expr('T * 20');
    });
    expect(codes(loop).filter((c) => c === 'parameter-cycle')).toHaveLength(2);
    // pitch reads W, which is on the cycle; the hole reads W directly.
    expect(diagnostics(loop)).toContain('parameter-dependency@$.parameters[5].expression');
    expect(diagnostics(loop)).toContain(
      'parameter-missing@$.features[1].args.origin[0].expression.postfix[0]',
    );
  });

  it('enforces the node, depth, document and dependency-chain limits at the boundary', () => {
    const doc = f10Expressions();
    // 128 leaves in a balanced sum are 255 nodes; one more `neg` makes exactly the limit.
    expect(balanced(128).postfix.length + 1).toBe(cadExpressionLimits.nodes);
    expect(
      codes(withLength(doc, { postfix: [...balanced(128).postfix, { operator: 'neg' }] })),
    ).toEqual(['dimension-range']);
    expect(codes(withLength(doc, balanced(129)))).toEqual(['limit-expression-nodes']);
    const lengthDepth = (depth: number): CadExpression => ({
      postfix: [
        { number: 5, unit: 'mm' },
        ...Array.from({ length: depth - 1 }, () => ({ operator: 'neg' as const })),
      ],
    });
    expect(codes(withLength(doc, lengthDepth(cadExpressionLimits.depth - 1)))).toEqual([]);
    expect(codes(withLength(doc, lengthDepth(cadExpressionLimits.depth)))).toEqual([
      'dimension-range',
    ]);
    expect(codes(withLength(doc, lengthDepth(cadExpressionLimits.depth + 1)))).toEqual([
      'limit-expression-depth',
    ]);
    // The postfix form keeps deep trees inside the JSON depth limit.
    expect(cadJsonShape(withLength(doc, lengthDepth(cadExpressionLimits.depth)))).toBeUndefined();

    // F10 already holds 15 nodes (T 3, pitch 9, hole x 3). Fill the document to the limit.
    const filled = (extra: CadExpression) =>
      mutate(doc, (d) => {
        const add = (i: number, expression: CadExpression) =>
          d.parameters.push({ id: `c${i}`, name: `c${i}`, type: 'length', expression });
        for (let i = 0; i < 64; i++) add(i, balanced(128));
        add(64, extra);
      });
    expect(15 + 64 * 255 + balanced(25).postfix.length).toBe(cadExpressionLimits.documentNodes);
    expect(codes(filled(balanced(25)))).toEqual([]);
    expect(
      codes(filled({ postfix: [...balanced(25).postfix, { operator: 'abs' as never }] })),
    ).toEqual(['expression-node']);
    expect(codes(filled({ postfix: [...balanced(25).postfix, { function: 'abs' }] }))).toEqual([
      'limit-expression-nodes',
    ]);

    const chainOf = (n: number) =>
      mutate(f02Plate(), (d) => {
        for (let i = 0; i < n; i++)
          d.parameters.push(
            i === 0
              ? { id: 'p0', name: 'p0', type: 'length', value: 1 }
              : {
                  id: `p${i}`,
                  name: `p${i}`,
                  type: 'length',
                  expression: { postfix: [{ parameterId: `p${i - 1}` }] },
                },
          );
      });
    expect(codes(chainOf(cadExpressionLimits.parameterDepth))).toEqual([]);
    expect(codes(chainOf(cadExpressionLimits.parameterDepth + 1))).toEqual([
      'limit-parameter-depth',
    ]);
  });

  it('keeps meaning when a parameter is renamed: expressions hold IDs', () => {
    const doc = f10Expressions();
    const renamed = applyCadOperation(doc, { type: 'rename', targetId: 'W', name: 'Breadth' });
    expect([...parameterValues(renamed)]).toEqual([...parameterValues(doc)]);
    expect(renamed.parameters.find((p) => p.id === 'T')).toEqual(
      doc.parameters.find((p) => p.id === 'T'),
    );
  });

  it('edits through commands: a valid expression commits, a cycle leaves source and history unchanged', () => {
    const s = new EditorSession(f10Expressions());
    exec(s, { type: 'setParameter', parameterId: 'H', expression: expr('W / 2') });
    expect(value(s.content, 'H')).toBe(50);
    const before = cadContentHash(s.content);
    expect(() =>
      exec(s, { type: 'setParameter', parameterId: 'W', expression: expr('T * 20') }),
    ).toThrow(/parameter-cycle/);
    expect(cadContentHash(s.content)).toBe(before);
    s.undo();
    expect(s.content.parameters.find((p) => p.id === 'H')).toEqual({
      id: 'H',
      name: 'Depth',
      type: 'length',
      value: 50,
    });
    // Back to a literal.
    exec(s, { type: 'setParameter', parameterId: 'T', value: 4 });
    expect(s.content.parameters.find((p) => p.id === 'T')).toEqual({
      id: 'T',
      name: 'Thickness',
      type: 'length',
      value: 4,
    });
    expect(() =>
      assertCadOperation({
        type: 'setParameter',
        parameterId: 'T',
        value: 1,
        expression: expr('W'),
      }),
    ).toThrow('operation-schema');
    expect(() => assertCadOperation({ type: 'setParameter', parameterId: 'T' })).toThrow(
      'operation-schema',
    );
  });

  it('deletes and duplicates along parameter dependencies', () => {
    const doc = f10Expressions();
    const closure = dependencyClosure(doc, ['m']);
    expect([...closure.parameters].sort()).toEqual(['m', 'pitch']);
    expect(closure.features.size).toBe(0);
    const w = dependencyClosure(doc, ['W']);
    expect([...w.parameters].sort()).toEqual(['T', 'W', 'pitch']);
    expect(w.features.has('plate-extrude')).toBe(true);
    expect(() =>
      applyCadOperation(doc, { type: 'deleteClosure', ids: ['m'], cascade: false }),
    ).toThrow('delete-has-dependents');
    const gone = applyCadOperation(doc, { type: 'deleteClosure', ids: ['m'], cascade: true });
    expect(gone.parameters.map((p) => p.id)).toEqual(['W', 'H', 'T', 'n']);
    // The plate's thickness reads T, which reads W: both are copied.
    const copied = duplicateClosureOf(doc, ['plate']);
    expect([...copied.parameters].sort()).toEqual(['H', 'T', 'W']);
    const idMap = Object.fromEntries(copied.ids.map((id) => [id, `${id}-copy`]));
    const dup = applyCadOperation(doc, { type: 'duplicateClosure', bodyIds: ['plate'], idMap });
    expect(dup.parameters.find((p) => p.id === 'T-copy')?.expression).toEqual({
      postfix: [{ parameterId: 'W-copy' }, { number: 20 }, { operator: 'div' }],
    });
    expect(value(dup, 'T-copy')).toBe(5);
  });
});

describe('schema identity (CAD28)', () => {
  it('creates schema 2 and refuses any other schema or semantics version with a reason', () => {
    const doc = emptyCad({ id: 'k', buildHash: `sha256:${'0'.repeat(64)}` });
    expect([doc.schemaVersion, doc.kernelProfile.semanticsVersion]).toEqual([2, 2]);
    expect(codes(doc)).toEqual([]);
    // Schema 1 development data is not read: it is refused, never read as schema 2.
    for (const schemaVersion of [1, 3, '2'])
      expect(diagnostics(mutate(f02Plate(), (d) => (d.schemaVersion = schemaVersion)))).toEqual([
        'unsupported-schema@$.schemaVersion',
      ]);
    for (const semanticsVersion of [1, 3])
      expect(
        codes(
          mutate(f10Expressions(), (d) => (d.kernelProfile.semanticsVersion = semanticsVersion)),
        ),
      ).toEqual(['unsupported-semantics']);
  });
});
