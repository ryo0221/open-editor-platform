import {
  CalculationError,
  decimal,
  add,
  subtract,
  multiply,
  divide,
  compare,
  quantize,
  formatDecimal,
  type Rounding,
} from './decimal';
import { convert, sameDimension, unitInfo } from './units';
import { assertJson, record, identifier, textValue } from './json';
export type ScalarType = { kind: 'text' | 'boolean' | 'date' } | { kind: 'decimal'; unit: string };
export type ScalarValue = string | boolean | null;
export type Expression =
  | { op: 'literal'; type: ScalarType; value: ScalarValue }
  | { op: 'field' | 'parameter'; id: string }
  | {
      op: 'add' | 'subtract' | 'multiply' | 'eq' | 'lt' | 'gt' | 'and' | 'or';
      left: Expression;
      right: Expression;
    }
  | { op: 'divide'; left: Expression; right: Expression; scale: number; rounding: Rounding }
  | { op: 'if'; condition: Expression; then: Expression; else: Expression }
  | { op: 'cast'; value: Expression; type: ScalarType }
  | { op: 'quantize'; value: Expression; scale: number; rounding: Rounding };
export interface ScalarEnvironment {
  fields: Record<string, ScalarType>;
  parameters: Record<string, ScalarType>;
}
export const decimalType = (unit = 'dimensionless'): ScalarType => ({ kind: 'decimal', unit });
export function assertType(value: unknown): asserts value is ScalarType {
  const r = record(value, ['kind'], ['unit']);
  if (r.kind === 'decimal') {
    if (typeof r.unit !== 'string') throw new CalculationError('invalid-type');
    unitInfo(r.unit);
  } else if (!['text', 'boolean', 'date'].includes(String(r.kind)) || Object.hasOwn(r, 'unit'))
    throw new CalculationError('invalid-type');
}
export function assertValue(value: unknown, type: ScalarType): asserts value is ScalarValue {
  if (value === null) return;
  if (type.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new CalculationError('type-mismatch');
    return;
  }
  textValue(value);
  if (type.kind === 'decimal') decimal(value);
  if (
    type.kind === 'date' &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    throw new CalculationError('invalid-date');
}
export function equalType(a: ScalarType, b: ScalarType): boolean {
  return (
    a.kind === b.kind &&
    (a.kind !== 'decimal' || (b.kind === 'decimal' && sameDimension(a.unit, b.unit)))
  );
}
export function expressionType(expression: unknown, env: ScalarEnvironment): ScalarType {
  assertJson(expression, 2 * 1024 * 1024);
  let nodes = 0;
  function visit(value: unknown, depth: number): ScalarType {
    if (++nodes > 256 || depth > 16) throw new CalculationError('expression-limit');
    if (!value || typeof value !== 'object') throw new CalculationError('invalid-expression');
    const op = (value as { op?: unknown }).op;
    if (op === 'literal') {
      const r = record(value, ['op', 'type', 'value']);
      assertType(r.type);
      assertValue(r.value, r.type);
      return r.type;
    }
    if (op === 'field' || op === 'parameter') {
      const r = record(value, ['op', 'id']);
      identifier(r.id);
      const types = op === 'field' ? env.fields : env.parameters;
      const t = Object.hasOwn(types, r.id) ? types[r.id] : undefined;
      if (!t) throw new CalculationError('missing-reference', r.id);
      return t;
    }
    if (op === 'if') {
      const r = record(value, ['op', 'condition', 'then', 'else']);
      if (visit(r.condition, depth + 1).kind !== 'boolean')
        throw new CalculationError('type-mismatch');
      const a = visit(r.then, depth + 1),
        b = visit(r.else, depth + 1);
      if (!equalType(a, b)) throw new CalculationError('type-mismatch');
      return a;
    }
    if (op === 'cast' || op === 'quantize') {
      const r = record(
        value,
        op === 'cast' ? ['op', 'value', 'type'] : ['op', 'value', 'scale', 'rounding'],
      );
      const a = visit(r.value, depth + 1);
      if (op === 'cast') {
        assertType(r.type);
        if (
          r.type.kind === 'decimal' &&
          a.kind === 'decimal' &&
          !sameDimension(a.unit, r.type.unit)
        )
          throw new CalculationError('unit-mismatch');
        if (
          a.kind !== r.type.kind &&
          !(a.kind === 'text' && r.type.kind === 'decimal') &&
          r.type.kind !== 'text'
        )
          throw new CalculationError('unsupported-cast');
        return r.type;
      }
      if (a.kind !== 'decimal') throw new CalculationError('type-mismatch');
      divide(decimal('1'), decimal('1'), r.scale as number, r.rounding as Rounding);
      return a;
    }
    if (
      !['add', 'subtract', 'multiply', 'divide', 'eq', 'lt', 'gt', 'and', 'or'].includes(String(op))
    )
      throw new CalculationError('unknown-operation');
    const r = record(
      value,
      op === 'divide' ? ['op', 'left', 'right', 'scale', 'rounding'] : ['op', 'left', 'right'],
    );
    const a = visit(r.left, depth + 1),
      b = visit(r.right, depth + 1);
    if (op === 'and' || op === 'or') {
      if (a.kind !== 'boolean' || b.kind !== 'boolean') throw new CalculationError('type-mismatch');
      return { kind: 'boolean' };
    }
    if (['eq', 'lt', 'gt'].includes(String(op))) {
      if (!equalType(a, b)) throw new CalculationError('type-mismatch');
      return { kind: 'boolean' };
    }
    if (a.kind !== 'decimal' || b.kind !== 'decimal') throw new CalculationError('type-mismatch');
    if (op === 'add' || op === 'subtract') {
      if (!sameDimension(a.unit, b.unit)) throw new CalculationError('unit-mismatch');
      return a;
    }
    if (op === 'divide')
      divide(decimal('1'), decimal('1'), r.scale as number, r.rounding as Rounding);
    if (b.unit === 'dimensionless') return a;
    if (op === 'multiply' && a.unit === 'dimensionless') return b;
    const rightUnit =
      op === 'multiply'
        ? '*' + b.unit
        : '/' + b.unit.replace(/[*/]/g, (separator) => (separator === '*' ? '/' : '*'));
    const result = decimalType(a.unit + rightUnit);
    assertType(result);
    return result;
  }
  return visit(expression, 1);
}
export function evaluateScalar(
  expr: Expression,
  env: ScalarEnvironment,
  fields: Record<string, ScalarValue>,
  parameters: Record<string, ScalarValue>,
): ScalarValue {
  expressionType(expr, env);
  function evaluate(e: Expression): ScalarValue {
    if (e.op === 'literal') return e.value;
    if (e.op === 'field' || e.op === 'parameter') {
      const values = e.op === 'field' ? fields : parameters;
      if (!Object.hasOwn(values, e.id)) throw new CalculationError('missing-value', e.id);
      const type = (e.op === 'field' ? env.fields : env.parameters)[e.id];
      assertValue(values[e.id], type);
      return values[e.id];
    }
    if (e.op === 'if') {
      const v = evaluate(e.condition);
      if (v === null) return null;
      const chosen = v ? e.then : e.else,
        result = evaluate(chosen),
        target = expressionType(e, env),
        from = expressionType(chosen, env);
      return result !== null && target.kind === 'decimal' && from.kind === 'decimal'
        ? formatDecimal(convert(decimal(String(result), false), from.unit, target.unit))
        : result;
    }
    if (e.op === 'cast' || e.op === 'quantize') {
      const v = evaluate(e.value);
      if (v === null) return null;
      if (e.op === 'quantize')
        return formatDecimal(quantize(decimal(String(v), false), e.scale, e.rounding));
      const from = expressionType(e.value, env);
      if (e.type.kind === 'text') return String(v);
      if (e.type.kind === 'decimal')
        return formatDecimal(
          from.kind === 'decimal'
            ? convert(decimal(String(v), false), from.unit, e.type.unit)
            : decimal(String(v)),
        );
      return v;
    }
    // field/parameter were handled above; narrow their shared discriminant explicitly.
    if (!('left' in e)) throw new CalculationError('unknown-operation');
    const a = evaluate(e.left),
      b = evaluate(e.right);
    if (e.op === 'and')
      return a === false || b === false ? false : a === null || b === null ? null : true;
    if (e.op === 'or')
      return a === true || b === true ? true : a === null || b === null ? null : false;
    if (a === null || b === null) return null;
    const at = expressionType(e.left, env),
      bt = expressionType(e.right, env);
    let order: number;
    if (at.kind === 'decimal' && bt.kind === 'decimal') {
      const x = decimal(String(a), false),
        y = ['add', 'subtract', 'eq', 'lt', 'gt'].includes(e.op)
          ? convert(decimal(String(b), false), bt.unit, at.unit)
          : decimal(String(b), false);
      if (e.op === 'add') return formatDecimal(add(x, y));
      if (e.op === 'subtract') return formatDecimal(subtract(x, y));
      if (e.op === 'multiply') return formatDecimal(multiply(x, y));
      if (e.op === 'divide') return formatDecimal(divide(x, y, e.scale, e.rounding));
      order = compare(x, y);
    } else
      order =
        typeof a === 'string' && typeof b === 'string'
          ? compareText(a, b)
          : a === b
            ? 0
            : a < b
              ? -1
              : 1;
    return e.op === 'eq' ? order === 0 : e.op === 'lt' ? order < 0 : order > 0;
  }
  return evaluate(expr);
}

/** Deterministic Unicode code point order, independent of locale and UTF-16 surrogate order. */
export function compareText(a: string, b: string): number {
  const x = Array.from(a),
    y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const delta = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (delta) return Math.sign(delta);
  }
  return Math.sign(x.length - y.length);
}
