import { WorkFields, type WorkDraft } from './work-fields';
import type {
  EstimateDocument,
  Quantity,
  Rate,
  Line,
  Adjustment,
} from '@editor-platform/estimate-core';
export type EditDraft =
  | { kind: 'work'; value: WorkDraft }
  | { kind: 'quantity'; value: Quantity }
  | { kind: 'rate'; value: Rate }
  | { kind: 'line'; value: Line }
  | { kind: 'adjustment'; value: Adjustment }
  | {
      kind: 'document';
      value: Pick<EstimateDocument, 'title' | 'description' | 'currency' | 'rounding'>;
    };
const units = [
  'dimensionless',
  'count',
  'mm',
  'cm',
  'm',
  'mm2',
  'm2',
  'mm3',
  'm3',
  'g',
  'kg',
  'minute',
  'hour',
  'workday',
];
function Field({
  label,
  value,
  change,
  disabled = false,
}: {
  label: string;
  value: string;
  change(value: string): void;
  disabled?: boolean;
}) {
  return (
    <label>
      {label}
      <input value={value} disabled={disabled} onChange={(e) => change(e.target.value)} />
    </label>
  );
}
function Unit({
  label,
  value,
  change,
  disabled = false,
}: {
  label: string;
  value: string;
  change(value: string): void;
  disabled?: boolean;
}) {
  return (
    <label>
      {label}
      <select disabled={disabled} value={value} onChange={(e) => change(e.target.value)}>
        {units.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </label>
  );
}
function Inclusion({
  value,
  reason,
  change,
}: {
  value: string;
  reason: string;
  change(p: object): void;
}) {
  return (
    <>
      <label>
        採用状態
        <select value={value} onChange={(e) => change({ inclusion: e.target.value })}>
          <option value="include">採用</option>
          <option value="pending">未確定</option>
          <option value="exclude">除外</option>
        </select>
      </label>
      {value === 'exclude' && (
        <Field
          label="除外理由"
          value={reason}
          change={(exclusionReason) => change({ exclusionReason })}
        />
      )}
    </>
  );
}
function OverrideFields({
  value,
  change,
}: {
  value?: { value: string; reason: string };
  change(value?: { value: string; reason: string }): void;
}) {
  return (
    <fieldset>
      <legend>手入力による上書き</legend>
      <label>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => change(e.target.checked ? { value: '0', reason: '' } : undefined)}
        />
        元値を残して上書きする
      </label>
      {value && (
        <>
          <Field
            label="上書き値"
            value={value.value}
            change={(v) => change({ ...value, value: v })}
          />
          <Field
            label="上書き理由"
            value={value.reason}
            change={(reason) => change({ ...value, reason })}
          />
        </>
      )}
    </fieldset>
  );
}
export function EstimateFields({
  draft,
  document,
  change,
}: {
  draft: EditDraft;
  document: EstimateDocument;
  change(draft: EditDraft): void;
}) {
  const patch = (p: object) => change({ ...draft, value: { ...draft.value, ...p } } as EditDraft);
  const optionalOverride = (override?: { value: string; reason: string }) => {
    const value = { ...draft.value };
    delete (value as Quantity).override;
    change({ ...draft, value: { ...value, ...(override ? { override } : {}) } } as EditDraft);
  };
  if (draft.kind === 'document') {
    const v = draft.value;
    return (
      <>
        <Field label="見積タイトル" value={v.title} change={(title) => patch({ title })} />
        <label>
          見積の説明
          <textarea
            value={v.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </label>
        <Field
          label="通貨コード"
          value={v.currency.code}
          change={(code) => patch({ currency: { ...v.currency, code } })}
        />
        <label>
          通貨の小数桁
          <select
            value={v.currency.minorDigits}
            onChange={(e) =>
              patch({ currency: { ...v.currency, minorDigits: Number(e.target.value) } })
            }
          >
            {[0, 1, 2, 3, 4].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          金額の丸め
          <select value={v.rounding} onChange={(e) => patch({ rounding: e.target.value })}>
            {['half-up', 'half-even', 'floor', 'ceil'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <p>各費目を丸めてから合計します。既存単価の通貨は自動換算しません。</p>
      </>
    );
  }
  if (draft.kind === 'work')
    return (
      <WorkFields
        value={draft.value}
        document={document}
        change={(value) => change({ kind: 'work', value })}
      />
    );
  const v = draft.value;
  return (
    <>
      <Field label="名称" value={v.name} change={(name) => patch({ name })} />
      {draft.kind === 'quantity' && (
        <>
          <Field
            label="数量（空欄は未入力）"
            value={draft.value.value ?? ''}
            disabled={!!draft.value.source}
            change={(value) => patch({ value: value === '' ? null : value })}
          />
          <Unit
            disabled={!!draft.value.source}
            label="数量単位"
            value={draft.value.unit}
            change={(unit) => patch({ unit })}
          />
          <Field
            label="数量の根拠・出典"
            value={draft.value.evidence}
            change={(evidence) => patch({ evidence })}
          />
          <p>
            {draft.value.source
              ? `保存版の数量です。元値を保持し、変更は理由付き上書きで行います。${draft.value.source.identity}`
              : '手入力数量です。CAD/BIMで計測した数量とは扱いません。'}
          </p>
          <OverrideFields value={draft.value.override} change={optionalOverride} />
          <Inclusion
            value={draft.value.inclusion}
            reason={draft.value.exclusionReason}
            change={patch}
          />
        </>
      )}
      {draft.kind === 'rate' && (
        <>
          <Field
            label="単価（空欄は未入力）"
            value={draft.value.unitPrice ?? ''}
            disabled={!!draft.value.source}
            change={(unitPrice) => patch({ unitPrice: unitPrice === '' ? null : unitPrice })}
          />
          <Unit
            label="単価あたりの単位"
            value={draft.value.perUnit}
            change={(perUnit) => patch({ perUnit })}
          />
          <Field
            label="単価の通貨"
            value={draft.value.currency}
            change={(currency) => patch({ currency })}
          />
          <Field
            label="単価の根拠・0円の理由"
            value={draft.value.evidence}
            change={(evidence) => patch({ evidence })}
          />
          {draft.value.source && (
            <p>
              保存Dataからの元値は保持します。変更は理由付きの上書きか、新版の明示採用を使ってください。
            </p>
          )}
          <OverrideFields value={draft.value.override} change={optionalOverride} />
        </>
      )}
      {draft.kind === 'line' && (
        <>
          <Field
            label="費目区分"
            value={draft.value.category}
            change={(category) => patch({ category })}
          />
          <Field label="備考" value={draft.value.note} change={(note) => patch({ note })} />
          <label>
            対応する単価
            <select
              value={draft.value.rateId ?? ''}
              onChange={(e) => patch({ rateId: e.target.value || null })}
            >
              <option value="">未対応</option>
              {document.rates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.unitPrice ?? '未入力'} {r.currency}/{r.perUnit}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>数量の対応と配賦</legend>
            {document.quantities.map((q) => {
              const bindings = draft.value.bindings;
              const binding = bindings.find((b) => b.quantityId === q.id);
              return (
                <div key={q.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!binding}
                      onChange={(e) =>
                        patch({
                          bindings: e.target.checked
                            ? [...bindings, { quantityId: q.id, allocationRatio: '1' }]
                            : bindings.filter((b) => b.quantityId !== q.id),
                        })
                      }
                    />
                    {q.name} · {q.value ?? '未入力'} {q.unit}
                  </label>
                  {binding && (
                    <Field
                      label={`${q.name}の配賦比率`}
                      value={binding.allocationRatio}
                      change={(allocationRatio) =>
                        patch({
                          bindings: bindings.map((b) =>
                            b.quantityId === q.id ? { ...b, allocationRatio } : b,
                          ),
                        })
                      }
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
          <Field
            label="ロス率（0〜1）"
            value={draft.value.wasteRatio}
            change={(wasteRatio) => patch({ wasteRatio })}
          />
          <label>
            <input
              type="checkbox"
              checked={!!draft.value.purchaseRounding}
              onChange={(e) => {
                const value = { ...draft.value };
                delete value.purchaseRounding;
                change({
                  kind: 'line',
                  value: {
                    ...value,
                    ...(e.target.checked
                      ? { purchaseRounding: { scale: 0, rounding: 'ceil' as const } }
                      : {}),
                  },
                });
              }}
            />
            購入数量を明示的に丸める
          </label>
          {draft.value.purchaseRounding && (
            <>
              <label>
                数量の小数桁
                <select
                  value={draft.value.purchaseRounding.scale}
                  onChange={(e) =>
                    patch({
                      purchaseRounding: {
                        ...draft.value.purchaseRounding,
                        scale: Number(e.target.value),
                      },
                    })
                  }
                >
                  {Array.from({ length: 13 }, (_, i) => (
                    <option key={i}>{i}</option>
                  ))}
                </select>
              </label>
              <label>
                数量の丸め
                <select
                  value={draft.value.purchaseRounding.rounding}
                  onChange={(e) =>
                    patch({
                      purchaseRounding: {
                        ...draft.value.purchaseRounding,
                        rounding: e.target.value,
                      },
                    })
                  }
                >
                  {['ceil', 'floor', 'half-up', 'half-even'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <Inclusion
            value={draft.value.inclusion}
            reason={draft.value.exclusionReason}
            change={patch}
          />
        </>
      )}
      {draft.kind === 'adjustment' && (
        <>
          <label>
            調整方法
            <select value={draft.value.kind} onChange={(e) => patch({ kind: e.target.value })}>
              <option value="fixed">固定額</option>
              <option value="percent">指定費目への率</option>
            </select>
          </label>
          <Field
            label={draft.value.kind === 'fixed' ? '調整額（値引きは負数）' : '調整率（-1〜1）'}
            value={draft.value.value}
            change={(value) => patch({ value })}
          />
          <Field
            label="調整の理由"
            value={draft.value.reason}
            change={(reason) => patch({ reason })}
          />
          {draft.value.kind === 'percent' && (
            <fieldset>
              <legend>率の対象費目</legend>
              {document.lines.map((l) => (
                <label key={l.id}>
                  <input
                    type="checkbox"
                    checked={draft.value.basisLineIds.includes(l.id)}
                    onChange={(e) =>
                      patch({
                        basisLineIds: e.target.checked
                          ? [...draft.value.basisLineIds, l.id]
                          : draft.value.basisLineIds.filter((id) => id !== l.id),
                      })
                    }
                  />
                  {l.name}
                </label>
              ))}
            </fieldset>
          )}
          <p>税率・法域は自動判定しません。調整額どうしの複利計算は非対応です。</p>
        </>
      )}
    </>
  );
}
