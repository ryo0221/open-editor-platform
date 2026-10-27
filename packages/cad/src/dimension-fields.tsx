/**
 * Fields for a length, angle or count that may be a literal, a parameter (shown, changed there)
 * or an expression over parameter names; a commit is one edit made by the caller.
 */
import { CommitInput } from '@editor-platform/editor-ui';
import {
  formatExpression,
  lengthParameter,
  parameterValues,
  resolveAngle,
  resolveLength,
  type Angle,
  type CadDocument,
  type Count,
  type Length,
} from '@editor-platform/cad-core';
import { readCadInput } from './expression-input';

export const parameterName = (doc: CadDocument) => (id: string) =>
  doc.parameters.find((p) => p.id === id)?.name ?? id;
export const fmt = (n: number, digits = 3) =>
  Math.abs(n) < 1e-12 ? '0' : Number(n.toFixed(digits)).toString();
/** `fmt` with digits grouped, for reading only (never an input's value). */
export const fmtGrouped = (n: number, digits = 3) =>
  Math.abs(n) < 1e-12
    ? '0'
    : Number(n.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
const metres = { mm: [1e3, 1e4, 'm'], 'mm²': [1e6, 1e6, 'm²'], 'mm³': [1e9, 1e9, 'm³'] } as const;
/**
 * A measured quantity for reading: digits grouped and, for building- or vehicle-sized values
 * (10 m, 1 m², 1 m³ and above), the value in metres beside it.
 */
export function fmtQuantity(n: number, unit: keyof typeof metres, digits = 3): string {
  const [scale, from, inMetres] = metres[unit];
  const text = `${fmtGrouped(n, digits)} ${unit}`;
  return Math.abs(n) >= from ? `${text} (${fmtGrouped(n / scale, 3)} ${inMetres})` : text;
}

export function LengthField({
  label,
  length,
  doc,
  disabled,
  onCommit,
}: {
  label: string;
  length: Length;
  doc: CadDocument;
  disabled?: boolean;
  onCommit: (value: Length) => void;
}) {
  const parameter = lengthParameter(length);
  if (parameter || disabled) {
    const p = doc.parameters.find((x) => x.id === parameter);
    const bound =
      'expression' in length ? formatExpression(length.expression, parameterName(doc)) : p?.name;
    return (
      <div className="cad-readonly-field">
        <span>{label}</span>
        <output>
          {fmt(resolveLength(length, parameterValues(doc)))} mm{bound ? ` (= ${bound})` : ''}
        </output>
      </div>
    );
  }
  return (
    <CommitInput
      label={`${label} (mm)`}
      value={
        'expression' in length
          ? formatExpression(length.expression, parameterName(doc))
          : (length as { literalMm: number }).literalMm
      }
      placeholder="mm or expression"
      onCommit={(text) => {
        const v = readCadInput(text, doc, 'length');
        onCommit('literal' in v ? { literalMm: v.literal } : v);
      }}
    />
  );
}

/** An angle in degrees or an expression; a parameter-bound angle is shown, not edited. */
export function AngleField({
  label,
  angle,
  doc,
  onCommit,
}: {
  label: string;
  angle: Angle;
  doc: CadDocument;
  onCommit: (value: Angle) => void;
}) {
  if ('parameterId' in angle)
    return (
      <div className="cad-readonly-field">
        <span>{label}</span>
        <output>
          {fmt((resolveAngle(angle, parameterValues(doc)) * 180) / Math.PI)}° (={' '}
          {parameterName(doc)(angle.parameterId)})
        </output>
      </div>
    );
  return (
    <CommitInput
      label={`${label} (°)`}
      value={
        'literalRad' in angle
          ? Number(((angle.literalRad * 180) / Math.PI).toFixed(6))
          : formatExpression(angle.expression, parameterName(doc))
      }
      placeholder="degrees or expression"
      onCommit={(text) => {
        const v = readCadInput(text, doc, 'angle');
        onCommit('literal' in v ? { literalRad: (v.literal * Math.PI) / 180 } : v);
      }}
    />
  );
}

/** A whole count, a count parameter (shown) or a dimensionless expression. */
export function CountField({
  label = 'Count',
  count,
  doc,
  onCommit,
}: {
  /** K6 uses it for a derived section's scale, a dimensionless factor. */
  label?: string;
  count: Count;
  doc: CadDocument;
  onCommit: (value: Count) => void;
}) {
  if ('parameterId' in count)
    return (
      <div className="cad-readonly-field">
        <span>{label}</span>
        <output>
          {parameterValues(doc).get(count.parameterId)?.value} (={' '}
          {parameterName(doc)(count.parameterId)})
        </output>
      </div>
    );
  return (
    <CommitInput
      label={label}
      value={
        'literal' in count ? count.literal : formatExpression(count.expression, parameterName(doc))
      }
      placeholder="number or expression"
      onCommit={(text) => {
        const v = readCadInput(text, doc, 'scalar');
        onCommit('literal' in v ? { literal: v.literal } : v);
      }}
    />
  );
}
