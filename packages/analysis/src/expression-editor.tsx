import {
  decimalType,
  expressionType,
  type Expression,
  type Rounding,
  type ScalarType,
} from '@editor-platform/calculation-core';
import type { Field } from '@editor-platform/analysis-core';
const operations = {
  literal: '定数',
  field: '列',
  parameter: 'Parameter',
  add: '加算',
  subtract: '減算',
  multiply: '乗算',
  divide: '除算',
  eq: '等しい',
  lt: 'より小さい',
  gt: 'より大きい',
  and: 'かつ',
  or: 'または',
  if: '条件分岐',
  cast: '型・単位変換',
  quantize: '丸め',
};
const literal = (): Expression => ({ op: 'literal', type: decimalType(), value: '1' });
export const roundingModes: Rounding[] = ['half-even', 'half-up', 'floor', 'ceil'];
export const typeLabel = (t: ScalarType) => (t.kind === 'decimal' ? `decimal [${t.unit}]` : t.kind);
function TypePicker({ value, change }: { value: ScalarType; change(t: ScalarType): void }) {
  return (
    <>
      <label>
        型
        <select
          value={value.kind}
          onChange={(e) =>
            change(
              e.target.value === 'decimal'
                ? decimalType()
                : { kind: e.target.value as 'text' | 'date' | 'boolean' },
            )
          }
        >
          {['decimal', 'text', 'boolean', 'date'].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      {value.kind === 'decimal' && (
        <label>
          単位
          <input value={value.unit} onChange={(e) => change(decimalType(e.target.value))} />
          <small>
            例: dimensionless、count、mm、m、m2、currency:JPY:0。型・次元は確定前に検査します。
          </small>
        </label>
      )}
    </>
  );
}
export function ExpressionEditor({
  value,
  change,
  fields,
  parameters,
  path = '式',
  depth = 1,
}: {
  value: Expression;
  change(e: Expression): void;
  fields: Field[];
  parameters: Field[];
  path?: string;
  depth?: number;
}) {
  const child = (key: string, expr: Expression, set: (e: Expression) => void) => (
    <ExpressionEditor
      value={expr}
      change={set}
      fields={fields}
      parameters={parameters}
      path={`${path} / ${key}`}
      depth={depth + 1}
    />
  );
  let type = '';
  try {
    type = typeLabel(
      expressionType(value, {
        fields: Object.fromEntries(fields.map((f) => [f.id, f.type])),
        parameters: Object.fromEntries(parameters.map((f) => [f.id, f.type])),
      }),
    );
  } catch (e) {
    type = `未確定: ${e instanceof Error ? e.message : String(e)}`;
  }
  return (
    <fieldset className="analysis-expression" aria-label={path}>
      <legend>{path.split(' / ').at(-1)}</legend>
      <label>
        式の種類
        <select
          value={value.op}
          onChange={(e) => {
            const op = e.target.value as Expression['op'];
            if (op === 'field' || op === 'parameter')
              change({ op, id: (op === 'field' ? fields : parameters)[0]?.id ?? '' });
            else if (op === 'literal') change(literal());
            else if (op === 'cast') change({ op, value: literal(), type: decimalType() });
            else if (op === 'quantize')
              change({ op, value: literal(), scale: 2, rounding: 'half-even' });
            else if (op === 'if')
              change({
                op,
                condition: { op: 'literal', type: { kind: 'boolean' }, value: true },
                then: literal(),
                else: literal(),
              });
            else if (op === 'divide')
              change({
                op,
                left: 'left' in value ? value.left : literal(),
                right: 'right' in value ? value.right : literal(),
                scale: 6,
                rounding: 'half-even',
              });
            else
              change({
                op,
                left: 'left' in value ? value.left : literal(),
                right: 'right' in value ? value.right : literal(),
              });
          }}
        >
          {Object.entries(operations).map(([op, label]) => (
            <option
              value={op}
              key={op}
              disabled={depth >= 16 && !['literal', 'field', 'parameter'].includes(op)}
            >
              {label}
            </option>
          ))}
        </select>
      </label>
      {(value.op === 'field' || value.op === 'parameter') && (
        <label>
          参照
          <select value={value.id} onChange={(e) => change({ ...value, id: e.target.value })}>
            <option value="">選択してください</option>
            {(value.op === 'field' ? fields : parameters).map((f) => (
              <option value={f.id} key={f.id}>
                {f.label} · {typeLabel(f.type)} · {f.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.op === 'literal' && (
        <>
          <TypePicker
            value={value.type}
            change={(type) =>
              change({ ...value, type, value: type.kind === 'boolean' ? false : '' })
            }
          />
          <label>
            <input
              type="checkbox"
              checked={value.value === null}
              onChange={(e) =>
                change({
                  ...value,
                  value: e.target.checked ? null : value.type.kind === 'boolean' ? false : '',
                })
              }
            />
            null（値なし）
          </label>
          {value.value !== null &&
            (value.type.kind === 'boolean' ? (
              <label>
                値
                <select
                  value={String(value.value)}
                  onChange={(e) => change({ ...value, value: e.target.value === 'true' })}
                >
                  <option>true</option>
                  <option>false</option>
                </select>
              </label>
            ) : (
              <label>
                値
                <input
                  value={String(value.value)}
                  onChange={(e) => change({ ...value, value: e.target.value })}
                />
              </label>
            ))}
        </>
      )}
      {'left' in value && (
        <div className="analysis-operands">
          {child('左辺', value.left, (left) => change({ ...value, left }))}
          {child('右辺', value.right, (right) => change({ ...value, right }))}
        </div>
      )}
      {value.op === 'if' && (
        <>
          {child('条件', value.condition, (condition) => change({ ...value, condition }))}
          {child('成立時', value.then, (then) => change({ ...value, then }))}
          {child('不成立時', value.else, (other) => change({ ...value, else: other }))}
        </>
      )}
      {(value.op === 'cast' || value.op === 'quantize') &&
        child('変換する値', value.value, (expr) => change({ ...value, value: expr }))}
      {value.op === 'cast' && (
        <TypePicker value={value.type} change={(type) => change({ ...value, type })} />
      )}
      {(value.op === 'divide' || value.op === 'quantize') && (
        <>
          <label>
            小数桁
            <input
              type="number"
              min="0"
              max="18"
              value={value.scale}
              onChange={(e) => change({ ...value, scale: Number(e.target.value) })}
            />
          </label>
          <label>
            丸め方法
            <select
              value={value.rounding}
              onChange={(e) => change({ ...value, rounding: e.target.value as Rounding })}
            >
              {roundingModes.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </>
      )}
      <small>{type}</small>
    </fieldset>
  );
}
