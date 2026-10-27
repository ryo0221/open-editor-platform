/**
 * Schema 2 expressions (docs/cad/r1-modeling.md, 式とparameter). Stored as a syntax tree in
 * postfix order, so neither the JSON depth limit nor recursion bounds how a tree nests. Parameters
 * are referenced by ID, so renaming one never changes what an expression means. Evaluation is
 * pure IEEE double arithmetic: no `eval`, no strings run as code.
 */
export type CadExprUnit = 'mm' | 'cm' | 'm' | 'in' | 'deg' | 'rad';
export type CadExprOperator = 'add' | 'sub' | 'mul' | 'div' | 'neg';
export type CadExprFunction = 'min' | 'max' | 'abs' | 'sqrt' | 'sin' | 'cos' | 'tan' | 'atan2';
export type CadExprNode =
  | { number: number; unit?: CadExprUnit }
  | { parameterId: string }
  | { constant: 'pi' }
  | { operator: CadExprOperator }
  | { function: CadExprFunction };
export interface CadExpression {
  /** Postfix (reverse Polish) order: each operator or function consumes the values before it. */
  postfix: CadExprNode[];
}
/** Counts behave as scalars inside an expression; a count site checks for an integer. */
export type CadExprType = 'length' | 'angle' | 'scalar';
export type CadParameterType = 'length' | 'angle' | 'count';
export type CadParameterValues = ReadonlyMap<string, { type: CadParameterType; value: number }>;

/** Safety limits proposed in r1-modeling.md. Not performance claims. */
export const cadExpressionLimits = Object.freeze({
  nodes: 256,
  depth: 32,
  documentNodes: 16_384,
  parameterDepth: 64,
  countMin: 1,
  countMax: 1_000,
});

export const cadExprUnits: Readonly<Record<CadExprUnit, { type: CadExprType; scale: number }>> =
  Object.freeze({
    mm: { type: 'length', scale: 1 },
    cm: { type: 'length', scale: 10 },
    m: { type: 'length', scale: 1000 },
    in: { type: 'length', scale: 25.4 },
    deg: { type: 'angle', scale: Math.PI / 180 },
    rad: { type: 'angle', scale: 1 },
  });
const operators: readonly CadExprOperator[] = ['add', 'sub', 'mul', 'div', 'neg'];
export const cadExprFunctions: Readonly<Record<CadExprFunction, number>> = Object.freeze({
  min: 2,
  max: 2,
  abs: 1,
  sqrt: 1,
  sin: 1,
  cos: 1,
  tan: 1,
  atan2: 2,
});
const arity = (n: CadExprNode) =>
  'operator' in n
    ? n.operator === 'neg'
      ? 1
      : 2
    : 'function' in n
      ? cadExprFunctions[n.function]
      : 0;

/** An expression error: `code` plus the postfix index it was found at, when there is one. */
export class CadExpressionError extends Error {
  constructor(
    readonly code: string,
    readonly node?: number,
  ) {
    super(code);
  }
}
const fail = (code: string, node?: number): never => {
  throw new CadExpressionError(code, node);
};

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v: Rec, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

/**
 * Structural check from unknown JSON: node shapes, stack balance, node and depth limits.
 * Returns the parameter IDs read, in order of first use. Does not look parameters up.
 */
export function checkExpressionShape(value: unknown, isId: (v: unknown) => boolean): string[] {
  if (!record(value) || !exactKeys(value, ['postfix']) || !Array.isArray(value.postfix))
    return fail('expression');
  const nodes = value.postfix as unknown[];
  if (!nodes.length) fail('expression-empty');
  if (nodes.length > cadExpressionLimits.nodes) fail('limit-expression-nodes');
  const depths: number[] = [];
  const reads: string[] = [];
  nodes.forEach((n, i) => {
    if (!record(n)) return fail('expression-node', i);
    let k: number;
    if (Object.hasOwn(n, 'number')) {
      const unitOk = !Object.hasOwn(n, 'unit') || Object.hasOwn(cadExprUnits, n.unit as string);
      if (
        !(exactKeys(n, ['number']) || exactKeys(n, ['number', 'unit'])) ||
        typeof n.number !== 'number' ||
        !Number.isFinite(n.number) ||
        typeof (n.unit ?? '') !== 'string' ||
        !unitOk
      )
        fail('expression-node', i);
      k = 0;
    } else if (Object.hasOwn(n, 'parameterId')) {
      if (!exactKeys(n, ['parameterId']) || !isId(n.parameterId)) fail('expression-node', i);
      if (!reads.includes(n.parameterId as string)) reads.push(n.parameterId as string);
      k = 0;
    } else if (Object.hasOwn(n, 'constant')) {
      if (!exactKeys(n, ['constant']) || n.constant !== 'pi') fail('expression-node', i);
      k = 0;
    } else if (Object.hasOwn(n, 'operator')) {
      if (!exactKeys(n, ['operator']) || !operators.includes(n.operator as CadExprOperator))
        fail('expression-node', i);
      k = n.operator === 'neg' ? 1 : 2;
    } else if (Object.hasOwn(n, 'function')) {
      if (
        !exactKeys(n, ['function']) ||
        typeof n.function !== 'string' ||
        !Object.hasOwn(cadExprFunctions, n.function)
      )
        fail('expression-node', i);
      k = cadExprFunctions[n.function as CadExprFunction];
    } else return fail('expression-node', i);
    if (depths.length < k) fail('expression-stack', i);
    const d = 1 + Math.max(0, ...depths.splice(depths.length - k, k));
    if (d > cadExpressionLimits.depth) fail('limit-expression-depth', i);
    depths.push(d);
  });
  if (depths.length !== 1) fail('expression-stack', nodes.length - 1);
  return reads;
}

/** Parameter IDs an expression reads (assumes the shape was checked). */
export const expressionReads = (e: CadExpression): string[] => [
  ...new Set(e.postfix.flatMap((n) => ('parameterId' in n ? [n.parameterId] : []))),
];

type Value = { type: CadExprType; value: number };
const exprType = (t: CadParameterType): CadExprType => (t === 'count' ? 'scalar' : t);

/**
 * Type-checks and evaluates. Throws `CadExpressionError` for a missing parameter, a type error
 * (length + angle, length × length, sin of a length), division by zero, a domain error (sqrt of a
 * negative) or a non-finite intermediate result.
 */
export function evaluateExpression(e: CadExpression, params: CadParameterValues): Value {
  const stack: Value[] = [];
  e.postfix.forEach((n, i) => {
    const k = arity(n);
    if (stack.length < k) fail('expression-stack', i);
    const args = stack.splice(stack.length - k, k);
    const r = step(n, args, params, i);
    if (!Number.isFinite(r.value)) fail('expression-non-finite', i);
    // −0 and +0 must give one canonical result.
    stack.push(r.value === 0 ? { type: r.type, value: 0 } : r);
  });
  if (stack.length !== 1) fail('expression-stack');
  return stack[0];
}

function step(n: CadExprNode, args: Value[], params: CadParameterValues, i: number): Value {
  if ('number' in n) {
    const u = n.unit ? cadExprUnits[n.unit] : undefined;
    return u ? { type: u.type, value: n.number * u.scale } : { type: 'scalar', value: n.number };
  }
  if ('parameterId' in n) {
    const p = params.get(n.parameterId) ?? fail('parameter-missing', i);
    return { type: exprType(p.type), value: p.value };
  }
  if ('constant' in n) return { type: 'scalar', value: Math.PI };
  const [a, b] = args;
  if ('operator' in n) {
    switch (n.operator) {
      case 'neg':
        return { type: a.type, value: -a.value };
      case 'add':
      case 'sub':
        if (a.type !== b.type) fail('expression-type', i);
        return {
          type: a.type,
          value: n.operator === 'add' ? a.value + b.value : a.value - b.value,
        };
      case 'mul':
        if (a.type !== 'scalar' && b.type !== 'scalar') fail('expression-type', i);
        return { type: a.type === 'scalar' ? b.type : a.type, value: a.value * b.value };
      case 'div': {
        const type =
          b.type === 'scalar' ? a.type : a.type === b.type ? 'scalar' : fail('expression-type', i);
        if (b.value === 0) fail('expression-division-by-zero', i);
        return { type, value: a.value / b.value };
      }
    }
  }
  const f = (n as { function: CadExprFunction }).function;
  switch (f) {
    case 'min':
    case 'max':
      if (a.type !== b.type) fail('expression-type', i);
      return { type: a.type, value: Math[f](a.value, b.value) };
    case 'abs':
      return { type: a.type, value: Math.abs(a.value) };
    case 'sqrt':
      if (a.type !== 'scalar') fail('expression-type', i);
      if (a.value < 0) fail('expression-domain', i);
      return { type: 'scalar', value: Math.sqrt(a.value) };
    case 'sin':
    case 'cos':
    case 'tan':
      if (a.type !== 'angle') fail('expression-type', i);
      return { type: 'scalar', value: Math[f](a.value) };
    case 'atan2':
      if (a.type !== b.type || a.type === 'angle') fail('expression-type', i);
      if (a.value === 0 && b.value === 0) fail('expression-domain', i);
      return { type: 'angle', value: Math.atan2(a.value, b.value) };
  }
}

// ---------------------------------------------------------------------------------------------
// Text form, for the Inspector input buffer. Parsing happens only when an input is committed.

export interface CadExpressionParseError {
  code: string;
  /** UTF-16 offset in the source text. */
  at: number;
}
const identStart = /[\p{L}_]/u;
const identPart = /[\p{L}\p{N}_]/u;
const reservedNames = new Set(['pi', ...Object.keys(cadExprFunctions)]);

type Token =
  | { t: 'num'; value: number; unit?: CadExprUnit; at: number }
  | { t: 'name'; name: string; braced: boolean; at: number }
  | { t: 'op'; op: string; at: number }
  | { t: 'end'; at: number };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    const at = i;
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw { code: 'expression-syntax', at } satisfies CadExpressionParseError;
      i += m[0].length;
      // A unit is written directly after the number (`2m`, `90deg`); `2 m` is not a unit.
      const u = /^(mm|cm|m|in|deg|rad)(?![\p{L}\p{N}_])/u.exec(src.slice(i));
      if (u) i += u[0].length;
      out.push({ t: 'num', value: Number(m[0]), unit: u?.[1] as CadExprUnit | undefined, at });
      continue;
    }
    if (ch === '{') {
      const end = src.indexOf('}', i + 1);
      if (end < 0) throw { code: 'expression-syntax', at } satisfies CadExpressionParseError;
      out.push({ t: 'name', name: src.slice(i + 1, end), braced: true, at });
      i = end + 1;
      continue;
    }
    if (identStart.test(ch)) {
      let j = i + 1;
      while (j < src.length && identPart.test(src[j])) j++;
      out.push({ t: 'name', name: src.slice(i, j), braced: false, at });
      i = j;
      continue;
    }
    const op = { '−': '-', '×': '*', '÷': '/' }[ch] ?? ch;
    if (!'+-*/(),'.includes(op))
      throw { code: 'expression-syntax', at } satisfies CadExpressionParseError;
    out.push({ t: 'op', op, at });
    i++;
  }
  out.push({ t: 'end', at: src.length });
  return out;
}

/**
 * Parses `W / 20`, `(W − 2 × m) / (n − 1)`, `90deg`, `atan2(h, w)`. Parameter names resolve
 * through `lookup` (an ID, `undefined` when unknown, `null` when two parameters share the name);
 * a name that is not a plain identifier is written in braces: `{wall thickness}`.
 */
export function parseExpression(
  src: string,
  lookup: (name: string) => string | null | undefined,
): { expression: CadExpression } | { error: CadExpressionParseError } {
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch (e) {
    return { error: e as CadExpressionParseError };
  }
  const postfix: CadExprNode[] = [];
  let pos = 0;
  const peek = () => tokens[pos];
  const err = (code: string, at = peek().at): never => {
    throw { code, at } satisfies CadExpressionParseError;
  };
  const isOp = (op: string) => {
    const t = peek();
    return t.t === 'op' && t.op === op;
  };
  const expect = (op: string) => (isOp(op) ? pos++ : err('expression-syntax'));
  const sum = (): void => {
    product();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { op: string }).op;
      product();
      postfix.push({ operator: op === '+' ? 'add' : 'sub' });
    }
  };
  const product = (): void => {
    unary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[pos++] as { op: string }).op;
      unary();
      postfix.push({ operator: op === '*' ? 'mul' : 'div' });
    }
  };
  const unary = (): void => {
    if (isOp('-')) {
      pos++;
      unary();
      postfix.push({ operator: 'neg' });
    } else if (isOp('+')) {
      pos++;
      unary();
    } else primary();
  };
  const primary = (): void => {
    const t = peek();
    if (t.t === 'num') {
      pos++;
      if (!Number.isFinite(t.value)) err('expression-number', t.at);
      postfix.push(t.unit ? { number: t.value, unit: t.unit } : { number: t.value });
      return;
    }
    if (t.t === 'op' && t.op === '(') {
      pos++;
      sum();
      expect(')');
      return;
    }
    if (t.t !== 'name') return err('expression-syntax');
    pos++;
    if (!t.braced && Object.hasOwn(cadExprFunctions, t.name) && isOp('(')) {
      pos++;
      const n = cadExprFunctions[t.name as CadExprFunction];
      for (let k = 0; k < n; k++) {
        if (k) expect(',');
        sum();
      }
      expect(')');
      postfix.push({ function: t.name as CadExprFunction });
      return;
    }
    if (!t.braced && t.name === 'pi') {
      postfix.push({ constant: 'pi' });
      return;
    }
    const id = lookup(t.name);
    if (id === null) err('expression-name-ambiguous', t.at);
    if (id === undefined) err('expression-name-unknown', t.at);
    postfix.push({ parameterId: id as string });
  };
  try {
    sum();
    if (peek().t !== 'end') err('expression-syntax');
  } catch (e) {
    return { error: e as CadExpressionParseError };
  }
  return { expression: { postfix } };
}

const precedence = { add: 1, sub: 1, mul: 2, div: 2, neg: 3 } as const;
const fmtNumber = (v: number) => String(v);

/**
 * Text form of an expression with parameter names. It parses back to an expression of the same
 * value and type; a stored negative literal comes back as a negated positive one.
 */
export function formatExpression(e: CadExpression, name: (id: string) => string): string {
  const stack: { text: string; prec: number }[] = [];
  for (const n of e.postfix) {
    if ('number' in n) stack.push({ text: `${fmtNumber(n.number)}${n.unit ?? ''}`, prec: 4 });
    else if ('parameterId' in n) {
      const s = name(n.parameterId);
      const plain =
        identStart.test(s[0] ?? '') &&
        [...s].every((c) => identPart.test(c)) &&
        !reservedNames.has(s) &&
        !s.includes('}');
      stack.push({ text: plain ? s : `{${s}}`, prec: 4 });
    } else if ('constant' in n) stack.push({ text: 'pi', prec: 4 });
    else if ('function' in n) {
      const k = cadExprFunctions[n.function];
      const args = stack.splice(stack.length - k, k).map((a) => a.text);
      stack.push({ text: `${n.function}(${args.join(', ')})`, prec: 4 });
    } else if (n.operator === 'neg') {
      const a = stack.pop()!;
      stack.push({ text: `-${a.prec < 3 ? `(${a.text})` : a.text}`, prec: 3 });
    } else {
      const b = stack.pop()!;
      const a = stack.pop()!;
      const p = precedence[n.operator];
      const sym = { add: '+', sub: '-', mul: '*', div: '/' }[n.operator];
      // Left-associative: the right operand needs brackets at equal precedence.
      const l = a.prec < p ? `(${a.text})` : a.text;
      const r = b.prec <= p ? `(${b.text})` : b.text;
      stack.push({ text: `${l} ${sym} ${r}`, prec: p });
    }
  }
  return stack[0]?.text ?? '';
}
