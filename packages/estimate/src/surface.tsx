import { EstimateBrowse, formatAmount as format } from './browse';
import type { EstimateBimEvaluator } from './bim-source';
import type { WorkPublicationHost, WorkPublicationPreview } from './publication';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import type { EditorInputBoundary } from '@editor-platform/editor-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { isStructuredData } from '@editor-platform/structured-data/model';
import {
  assertEstimateAccess,
  evaluateEstimate,
  makeEstimateBasis,
  calculationDifference,
  explainCalculationDifference,
  estimateCsv,
  estimateData,
  retainPriceData,
  priceValue,
  type EstimateDocument,
  type EstimateResult,
} from '@editor-platform/estimate-core';
import {
  EstimateController,
  type EstimatePort,
  type EstimateWorkerFactory,
  type EstimateCandidate,
} from './host';
import type { EstimateSourceOption, EstimateGeometrySourceOption } from './sources';
import { EstimateFields, type EditDraft } from './forms';
const EstimateCadPanel = lazy(() =>
  import('./cad-panel').then((m) => ({ default: m.EstimateCadPanel })),
);
const EstimateBimPanel = lazy(() =>
  import('./bim-panel').then((m) => ({ default: m.EstimateBimPanel })),
);
export interface EstimateSurfaceProps {
  port: EstimatePort;
  publication?: WorkPublicationHost;
  sources?: EstimateSourceOption[];
  quantitySources?: EstimateGeometrySourceOption[];
  bimSources?: EstimateGeometrySourceOption[];
  evaluateBim?: EstimateBimEvaluator;
  worker?: EstimateWorkerFactory;
  registerInput?(boundary: EditorInputBoundary): () => void;
  save(): Promise<void>;
  history(direction: 'undo' | 'redo'): void;
  copyData?(data: StructuredData, requestId: string): Promise<void>;
  select?(id: string): void;
  openSource?(id: string): void;
}
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function EstimateSurface(props: EstimateSurfaceProps) {
  const latest = useRef(props);
  latest.current = props;
  const [draft, updateDraft] = useState<EditDraft>();
  const buffer = useRef({
    draft: undefined as EditDraft | undefined,
    composing: false,
    committing: false,
  });
  const setDraft = (d?: EditDraft) => {
    buffer.current.draft = d;
    updateDraft(d);
  };
  const [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const execution = useRef(0);
  const [retention, setRetention] = useState<'append' | 'replace'>('append');
  const [changedOnly, setChangedOnly] = useState(false);
  const formRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (draft) {
      formRef.current?.scrollIntoView({ block: 'center' });
      formRef.current?.querySelector<HTMLElement>('input,select,textarea')?.focus();
    }
  }, [draft?.kind, draft && 'id' in draft.value ? draft.value.id : '']);
  const [workPublication, setWorkPublication] = useState<WorkPublicationPreview>();
  const [scenario, setScenario] = useState(''),
    [scenarioName, setScenarioName] = useState(''),
    [selectedCalculation, setSelectedCalculation] = useState(''),
    [compare, setCompare] = useState('');
  const [candidate, setCandidate] = useState<EstimateCandidate>(),
    [verified, setVerified] = useState('');
  const [sourceIndex, setSourceIndex] = useState(0),
    [sourceRow, setSourceRow] = useState(''),
    [sourceField, setSourceField] = useState('');
  const port = useMemo<EstimatePort>(
    () => ({
      get quantityVerification() {
        return latest.current.port.quantityVerification;
      },
      read: () => latest.current.port.read(),
      revision: () => latest.current.port.revision(),
      generation: () => latest.current.port.generation(),
      canEdit: () => latest.current.port.canEdit(),
      canRead: (p) => latest.current.port.canRead(p),
      canExport: () => latest.current.port.canExport(),
      inputsReady: () =>
        !buffer.current.composing &&
        (!buffer.current.draft || buffer.current.committing) &&
        latest.current.port.inputsReady(),
      execute: (command) => latest.current.port.execute(command),
      flush: () => {
        if (buffer.current.composing) throw Error('IME変換を確定してください。');
        if (buffer.current.draft && !buffer.current.committing)
          throw Error('編集中の項目を確定または取消してください。');
        latest.current.port.flush();
      },
    }),
    [],
  );
  const controller = useMemo(
    () => new EstimateController(port, props.worker),
    [port, props.worker],
  );
  useEffect(() => () => controller.close(), [controller]);
  useEffect(
    () =>
      props.registerInput?.({
        label: '見積項目の編集',
        read: () => ({ dirty: !!buffer.current.draft, composing: buffer.current.composing }),
        prepare: () => {
          if (buffer.current.composing) throw Error('IME変換を確定してください。');
          if (buffer.current.draft && !buffer.current.committing)
            throw Error('見積項目を確定または取消してください。');
          return () => {};
        },
        focus: () => {},
      }),
    [props.registerInput],
  );
  const revision = props.port.revision(),
    generation = props.port.generation();
  // Session.read returns an owned clone. Refresh it on the Host's revision/scope boundary.
  const document = useMemo(() => props.port.read(), [props.port, revision, generation]);
  const readOnly = !props.port.canEdit();
  let readable = true;
  try {
    assertEstimateAccess(document, props.port);
  } catch {
    readable = false;
  }
  const signature = canonicalJson([props.port.revision(), props.port.generation(), readable]);
  const calculation =
    document.calculations.find((c) => c.id === selectedCalculation) ?? document.calculations.at(-1);
  useEffect(() => {
    let active = true;
    setVerified('');
    if (calculation && readable && !draft)
      void controller
        .verifiedCalculation(calculation.id)
        .then(() => {
          if (active) setVerified(signature);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [controller, signature, calculation?.id, readable, draft]);
  const attempt = async (fn: () => void | Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const editing = (next: EstimateDocument, label: string) => {
    port.flush();
    controller.edit(next, label);
  };
  const open = (d: EditDraft) => {
    if (buffer.current.draft) {
      setError('編集中の項目を確定または取消してください。');
      return;
    }
    execution.current++;
    controller.cancel();
    setBusy(false);
    setCandidate(undefined);
    setDraft(structuredClone(d));
  };
  function commit() {
    const d = buffer.current.draft;
    if (!d) return;
    if (buffer.current.composing) throw Error('IME変換を確定してください。');
    buffer.current.committing = true;
    try {
      port.flush();
      const current = port.read();
      let next: EstimateDocument;
      if (d.kind === 'document' || d.kind === 'work') next = { ...current, ...d.value };
      else {
        const key = {
          quantity: 'quantities',
          rate: 'rates',
          line: 'lines',
          adjustment: 'adjustments',
        }[d.kind] as 'quantities' | 'rates' | 'lines' | 'adjustments';
        const entries = current[key];
        next = {
          ...current,
          [key]: entries.some((v) => v.id === d.value.id)
            ? entries.map((v) => (v.id === d.value.id ? d.value : v))
            : [...entries, d.value],
        };
      }
      controller.edit(next, 'Edit estimate item');
      setDraft(undefined);
    } finally {
      buffer.current.committing = false;
    }
  }
  const newItem = (kind: 'quantity' | 'rate' | 'line' | 'adjustment') => {
    const id = newId(kind);
    if (kind === 'quantity')
      open({
        kind,
        value: {
          id,
          name: '数量',
          value: null,
          unit: 'count',
          quality: 'manual',
          evidence: '',
          inclusion: 'include',
          exclusionReason: '',
        },
      });
    if (kind === 'rate')
      open({
        kind,
        value: {
          id,
          name: '単価',
          unitPrice: null,
          perUnit: 'count',
          currency: document.currency.code,
          evidence: '',
        },
      });
    if (kind === 'line')
      open({
        kind,
        value: {
          id,
          name: '費目',
          category: '材料',
          note: '',
          rateId: document.rates[0]?.id ?? null,
          bindings: document.quantities[0]
            ? [{ quantityId: document.quantities[0].id, allocationRatio: '1' }]
            : [],
          wasteRatio: '0',
          inclusion: 'include',
          exclusionReason: '',
        },
      });
    if (kind === 'adjustment')
      open({
        kind,
        value: { id, name: '調整', kind: 'fixed', value: '0', basisLineIds: [], reason: '' },
      });
  };
  const { report, reportError, historical } = useMemo(() => {
    if (!readable) return { report: undefined, reportError: '', historical: false };
    try {
      const basis = makeEstimateBasis(document, scenario || null);
      return {
        report: evaluateEstimate(basis),
        reportError: '',
        historical:
          !!calculation &&
          canonicalJson(calculation.basis) !==
            canonicalJson(
              calculation.basis.scenarioId === (scenario || null)
                ? basis
                : makeEstimateBasis(document, calculation.basis.scenarioId),
            ),
      };
    } catch (e) {
      return { report: undefined, reportError: String(e), historical: !!calculation };
    }
  }, [document, scenario, readable, calculation]);
  const focusDiagnostic = (
    id: string,
    code = '',
    target: EstimateResult['diagnostics'][number]['target'] = 'line',
  ) => {
    // Collection IDs may overlap; the producer identifies the diagnostic's namespace.
    if (target === 'work' && document.workPlan) {
      open({ kind: 'work', value: { workPlan: document.workPlan, workRules: document.workRules } });
    } else if (target === 'adjustment') {
      const adjustment = document.adjustments.find((a) => a.id === id);
      if (adjustment) open({ kind: 'adjustment', value: adjustment });
    } else if (target === 'quantity') {
      const quantity = document.quantities.find((q) => q.id === id);
      if (quantity) open({ kind: 'quantity', value: quantity });
    } else if (target === 'line') {
      const line = document.lines.find((l) => l.id === id);
      const rate =
        code === 'missing-price' ? document.rates.find((r) => r.id === line?.rateId) : undefined;
      if (rate) open({ kind: 'rate', value: rate });
      else if (line) open({ kind: 'line', value: line });
    } else if (target === 'document') {
      setError('調整額と対象費目を確認してください。合計は項目として編集できません。');
    }
    props.select?.(id);
  };
  const orderedResults = useMemo(() => {
    const order = new Map(calculation?.basis.lines.map((l, i) => [l.id, i]) ?? []);
    return [...(calculation?.result.lines ?? [])].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  }, [calculation]);
  const explained = useMemo(() => {
    const before = candidate?.base.calculations.at(-1),
      after = candidate?.document.calculations.at(-1);
    return before &&
      after &&
      canonicalJson(before.basis.currency) === canonicalJson(after.basis.currency)
      ? explainCalculationDifference(before, after)
      : [];
  }, [candidate]);
  const source = props.sources?.[sourceIndex],
    native = source && isStructuredData(source.content) ? source.content : undefined;
  async function importRate() {
    port.flush();
    if (!source || !sourceRow || !sourceField)
      throw Error('保存Dataの版・行・単価列を選択してください。');
    const revision = port.revision(),
      base = structuredClone(port.read()),
      retained = await retainPriceData(source.pin, source.content);
    if (revision !== port.revision()) throw Error('単価取得中に編集されました。');
    const rate = {
      id: newId('rate'),
      name: `${source.label} / ${sourceRow}`,
      unitPrice: priceValue(source.content, sourceRow, sourceField),
      perUnit: 'count',
      currency: base.currency.code,
      evidence: `保存Dataの明示選択: ${sourceRow}/${sourceField}`,
      source: { snapshotKey: retained.key, rowId: sourceRow, fieldId: sourceField },
    };
    controller.edit(
      {
        ...base,
        rates: [...base.rates, rate],
        retainedSources: base.retainedSources.some((s) => s.key === retained.key)
          ? base.retainedSources
          : [...base.retainedSources, retained],
      },
      'Add saved Data price',
    );
    setStatus('保存版の単価を追加しました。単価あたりの単位を確認してください。');
  }
  async function trialPrice(rateId: string) {
    port.flush();
    const revision = port.revision(),
      base = structuredClone(port.read()),
      rate = base.rates.find((r) => r.id === rateId)!;
    const old = base.retainedSources.find((s) => s.key === rate.source?.snapshotKey)!;
    const update = props.sources?.find(
      (s) =>
        s.latest &&
        s.pin.artifactId === old.pin.artifactId &&
        s.pin.versionId !== old.pin.versionId,
    );
    if (!update || !rate.source) throw Error('新しい保存版はありません。');
    const retained = await retainPriceData(update.pin, update.content);
    const value = priceValue(update.content, rate.source.rowId, rate.source.fieldId);
    if (revision !== port.revision()) throw Error('単価取得中に編集されました。');
    const next = {
      ...base,
      rates: base.rates.map((r) =>
        r.id === rateId
          ? { ...r, unitPrice: value, source: { ...rate.source!, snapshotKey: retained.key } }
          : r,
      ),
      retainedSources: base.retainedSources.some((s) => s.key === retained.key)
        ? base.retainedSources
        : [...base.retainedSources, retained],
    };
    setCandidate(await controller.prepare(scenario || null, next, retention));
  }
  const execute = async (preview: boolean) => {
    const token = ++execution.current;
    setBusy(true);
    try {
      if (preview) setCandidate(await controller.prepare(scenario || null, undefined, retention));
      else {
        await controller.run(scenario || null, retention);
        setSelectedCalculation('');
        setStatus('計算結果を採用しました。');
      }
    } finally {
      if (token === execution.current) setBusy(false);
    }
  };
  return (
    <section className="ep-estimate" aria-label="見積・積算">
      <header>
        <h2>{document.title}</h2>
        <p>
          単一通貨 {document.currency.code} · 費目ごとに小数{document.currency.minorDigits}桁へ
          {document.rounding}。手入力数量・明示的な保存Data単価を使います。
        </p>
        <p>{document.description}</p>
        <label>
          次の計算記録の保持
          <select
            value={retention}
            disabled={busy || readOnly}
            onChange={(e) => setRetention(e.target.value as 'append' | 'replace')}
          >
            <option value="append">記録を追加</option>
            <option value="replace">作業中の記録を置換（新しい結果だけ保持）</option>
          </select>
        </label>
        <p>
          計算記録 {document.calculations.length} / 5件 · 使用容量{' '}
          {Math.ceil(new TextEncoder().encode(JSON.stringify(document)).length / 1024)} / 2048
          KiB。置換は成功の採用時だけ行い、Undoできます。過去の結果を残すには先に保存してください。保存済み版は変更しません。
        </p>
        <div className="estimate-actions">
          <button disabled={readOnly || busy} onClick={() => void attempt(() => execute(false))}>
            計算して採用
          </button>
          <button disabled={readOnly || busy} onClick={() => void attempt(() => execute(true))}>
            試算して比較
          </button>
          <button
            disabled={!busy}
            onClick={() => {
              execution.current++;
              controller.cancel();
              setBusy(false);
            }}
          >
            計算を取消
          </button>
          <button
            disabled={readOnly}
            onClick={() =>
              void attempt(() => {
                execution.current++;
                controller.cancel();
                port.flush();
                props.history('undo');
              })
            }
          >
            Undo
          </button>
          <button
            disabled={readOnly}
            onClick={() =>
              void attempt(() => {
                execution.current++;
                controller.cancel();
                port.flush();
                props.history('redo');
              })
            }
          >
            Redo
          </button>
          <button
            disabled={readOnly || busy}
            onClick={() =>
              void attempt(async () => {
                port.flush();
                await props.save();
                setStatus('保存しました。');
              })
            }
          >
            保存
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <p role="status">{busy ? '計算中…' : status}</p>
      </header>
      {!readable ? (
        <p role="alert">
          単価入力への閲覧権限がありません。数量・単価・派生結果を非表示にしました。
        </p>
      ) : (
        <>
          <fieldset disabled={readOnly}>
            <legend>見積条件</legend>
            <button
              onClick={() =>
                open({
                  kind: 'document',
                  value: {
                    title: document.title,
                    description: document.description,
                    currency: document.currency,
                    rounding: document.rounding,
                  },
                })
              }
            >
              説明・通貨を編集
            </button>
            <button onClick={() => newItem('quantity')}>数量を追加</button>
            <button onClick={() => newItem('rate')}>単価を追加</button>
            <button onClick={() => newItem('line')}>費目を追加</button>
            <button onClick={() => newItem('adjustment')}>調整を追加</button>
            <button
              onClick={() =>
                open({
                  kind: 'work',
                  value: {
                    workRules: document.workRules,
                    workPlan: document.workPlan ?? {
                      projectStartDate: new Date().toISOString().slice(0, 10),
                      calendar: { weekdays: [1, 2, 3, 4, 5], exceptions: [] },
                      tasks: [],
                      dependencies: [],
                    },
                  },
                })
              }
            >
              工程条件を編集
            </button>
          </fieldset>
          {draft && (
            <section ref={formRef} className="estimate-form" aria-label="項目の編集">
              <h3>項目の編集</h3>
              <p>確定するまで計算・保存・Undoを止めます。空欄は0と区別します。</p>
              <fieldset
                disabled={readOnly}
                onCompositionStart={() => {
                  buffer.current.composing = true;
                }}
                onCompositionEnd={() => {
                  buffer.current.composing = false;
                }}
              >
                <EstimateFields draft={draft} document={document} change={setDraft} />
              </fieldset>
              <button disabled={readOnly} onClick={() => void attempt(commit)}>
                項目を確定
              </button>
              <button
                onClick={() =>
                  void attempt(() => {
                    if (buffer.current.composing) throw Error('IME変換を確定してください。');
                    setDraft(undefined);
                  })
                }
              >
                編集を取消
              </button>
            </section>
          )}
          {props.quantitySources && (
            <Suspense fallback={<p>数量操作を読み込み中…</p>}>
              <EstimateCadPanel
                port={port}
                sources={props.quantitySources}
                edit={editing}
                trial={async (next) => {
                  setCandidate(await controller.prepare(scenario || null, next, retention));
                }}
              />
            </Suspense>
          )}
          {props.bimSources && (
            <Suspense fallback={<p>BIM数量操作を読み込み中…</p>}>
              <EstimateBimPanel
                port={port}
                sources={props.bimSources}
                evaluate={props.evaluateBim}
                edit={editing}
                trial={async (next) => {
                  setCandidate(await controller.prepare(scenario || null, next, retention));
                }}
              />
            </Suspense>
          )}
          <div className="estimate-columns">
            <section aria-label="数量一覧">
              <h3>数量と根拠</h3>
              <EstimateBrowse label="数量" items={document.quantities}>
                {(items) =>
                  items.map((q) => (
                    <article key={q.id}>
                      <button className="estimate-selection" onClick={() => props.select?.(q.id)}>
                        {q.name}
                      </button>
                      <p>
                        {q.value === null ? '未入力' : format(q.value)} {q.unit} ·{' '}
                        {q.quality === 'manual'
                          ? '手入力'
                          : q.quality === 'cad'
                            ? '保存CADの個数'
                            : q.quality}{' '}
                        ·{' '}
                        {q.inclusion === 'exclude'
                          ? `除外: ${q.exclusionReason}`
                          : q.inclusion === 'pending'
                            ? '未確定'
                            : '採用'}
                      </p>
                      <p>{q.evidence}</p>
                      {q.source && (
                        <p>
                          版{' '}
                          {
                            document.retainedSources.find((s) => s.key === q.source!.snapshotKey)
                              ?.pin.versionId
                          }{' '}
                          · {q.source.metric} · {q.source.identity}
                          {props.openSource && (
                            <button
                              onClick={() =>
                                props.openSource?.(
                                  document.retainedSources.find(
                                    (s) => s.key === q.source!.snapshotKey,
                                  )!.pin.artifactId,
                                )
                              }
                            >
                              数量の元データを開く
                            </button>
                          )}
                        </p>
                      )}
                      {q.override && (
                        <p>
                          上書き: {format(q.override.value)} / 理由: {q.override.reason}
                          （元値は保持）
                        </p>
                      )}
                      <button
                        disabled={readOnly}
                        onClick={() => open({ kind: 'quantity', value: q })}
                      >
                        数量を編集
                      </button>
                      <button
                        disabled={readOnly}
                        onClick={() =>
                          void attempt(() =>
                            editing(
                              {
                                ...port.read(),
                                quantities: port.read().quantities.filter((v) => v.id !== q.id),
                              },
                              'Delete quantity',
                            ),
                          )
                        }
                      >
                        数量を削除
                      </button>
                    </article>
                  ))
                }
              </EstimateBrowse>
            </section>
            <section aria-label="単価一覧">
              <h3>単価と根拠</h3>
              <EstimateBrowse label="単価" items={document.rates}>
                {(items) =>
                  items.map((r) => {
                    const s = document.retainedSources.find((s) => s.key === r.source?.snapshotKey);
                    const update =
                      s &&
                      props.sources?.some(
                        (v) =>
                          v.latest &&
                          v.pin.artifactId === s.pin.artifactId &&
                          v.pin.versionId !== s.pin.versionId,
                      );
                    return (
                      <article key={r.id}>
                        <h4>{r.name}</h4>
                        <p>
                          {r.unitPrice === null ? '未入力' : format(r.unitPrice)} {r.currency}/
                          {r.perUnit}
                        </p>
                        <p>{r.evidence}</p>
                        {r.override && (
                          <p>
                            上書き: {format(r.override.value)} / 理由: {r.override.reason}
                          </p>
                        )}
                        {s && (
                          <>
                            <p>
                              保存版: {s.pin.versionId} · 行 {r.source!.rowId} / 列{' '}
                              {r.source!.fieldId}
                            </p>
                            <button onClick={() => props.openSource?.(s.pin.artifactId)}>
                              元の単価Dataへ
                            </button>
                            {update && (
                              <>
                                <p>新版があります。現在の単価は固定したままです。</p>
                                <button
                                  disabled={readOnly || busy}
                                  onClick={() => void attempt(() => trialPrice(r.id))}
                                >
                                  新版単価で試算
                                </button>
                              </>
                            )}
                          </>
                        )}
                        <button
                          disabled={readOnly}
                          onClick={() => open({ kind: 'rate', value: r })}
                        >
                          単価を編集
                        </button>
                        <button
                          disabled={readOnly}
                          onClick={() =>
                            void attempt(() =>
                              editing(
                                {
                                  ...port.read(),
                                  rates: port.read().rates.filter((v) => v.id !== r.id),
                                },
                                'Delete rate',
                              ),
                            )
                          }
                        >
                          単価を削除
                        </button>
                      </article>
                    );
                  })
                }
              </EstimateBrowse>
              <details>
                <summary>保存Dataから単価を追加</summary>
                <fieldset disabled={readOnly}>
                  <label>
                    単価Dataの保存版
                    <select
                      value={sourceIndex}
                      onChange={(e) => {
                        setSourceIndex(Number(e.target.value));
                        setSourceRow('');
                        setSourceField('');
                      }}
                    >
                      {!props.sources?.length && <option>保存済みDataなし</option>}
                      {props.sources?.map((s, i) => (
                        <option value={i} key={s.pin.artifactId + s.pin.versionId}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    単価の行ID
                    <select value={sourceRow} onChange={(e) => setSourceRow(e.target.value)}>
                      <option value="">選択</option>
                      {native?.rows.map((r) => (
                        <option key={r.id}>{r.id}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    単価の列
                    <select value={sourceField} onChange={(e) => setSourceField(e.target.value)}>
                      <option value="">選択</option>
                      {native?.columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button onClick={() => void attempt(importRate)}>保存単価を追加</button>
                  <p>
                    number/text列のdecimalだけを使用。formula・表示名による推測対応は非対応です。
                  </p>
                </fieldset>
              </details>
            </section>
          </div>
          <section aria-label="費目一覧">
            <h3>費目・配賦・ロス</h3>
            <EstimateBrowse label="費目" items={document.lines}>
              {(items) =>
                items.map((l) => (
                  <article key={l.id}>
                    <button className="estimate-selection" onClick={() => props.select?.(l.id)}>
                      {l.name}
                    </button>
                    <p>
                      {l.category} ·{' '}
                      {l.bindings
                        .map(
                          (b) =>
                            `${document.quantities.find((q) => q.id === b.quantityId)?.name}: 配賦${b.allocationRatio}`,
                        )
                        .join(' / ')}{' '}
                      · ロス率{l.wasteRatio}
                    </p>
                    <p>
                      単価: {document.rates.find((r) => r.id === l.rateId)?.name ?? '未対応'} ·{' '}
                      {l.inclusion === 'exclude'
                        ? `除外: ${l.exclusionReason}`
                        : l.inclusion === 'pending'
                          ? '未確定'
                          : '採用'}
                    </p>
                    <p>{l.note}</p>
                    <button disabled={readOnly} onClick={() => open({ kind: 'line', value: l })}>
                      費目を編集
                    </button>
                    <button
                      disabled={readOnly}
                      onClick={() =>
                        void attempt(() =>
                          editing(
                            {
                              ...port.read(),
                              lines: port.read().lines.filter((v) => v.id !== l.id),
                            },
                            'Delete line',
                          ),
                        )
                      }
                    >
                      費目を削除
                    </button>
                  </article>
                ))
              }
            </EstimateBrowse>
          </section>
          <section aria-label="調整一覧">
            <h3>調整額</h3>
            {document.adjustments.map((a) => (
              <article key={a.id}>
                <h4>{a.name}</h4>
                <p>
                  {a.kind === 'percent'
                    ? `率 ${a.value} / 対象 ${a.basisLineIds.length + '費目'}`
                    : `${format(a.value)} ${document.currency.code}`}{' '}
                  · {a.reason}
                </p>
                <button disabled={readOnly} onClick={() => open({ kind: 'adjustment', value: a })}>
                  調整を編集
                </button>
                <button
                  disabled={readOnly}
                  onClick={() =>
                    void attempt(() =>
                      editing(
                        {
                          ...port.read(),
                          adjustments: port.read().adjustments.filter((v) => v.id !== a.id),
                        },
                        'Delete adjustment',
                      ),
                    )
                  }
                >
                  調整を削除
                </button>
              </article>
            ))}
          </section>
          <section aria-label="現在の見積診断">
            <h3>現在の条件の確認</h3>
            {reportError && <p>{reportError}</p>}
            {report && (
              <>
                <p>
                  {report.total === null
                    ? `未解決${report.diagnostics.length}件 · 集計済み小計 ${format(report.subtotal)} ${document.currency.code}（見積合計ではありません）`
                    : `計算可能 · 試算値 ${format(report.total)} ${document.currency.code}（採用・保存前）`}
                </p>
                {report.diagnostics.map((d, i) => (
                  <p key={i}>
                    {d.code}: {d.message}{' '}
                    <button onClick={() => focusDiagnostic(d.id, d.code, d.target)}>
                      対象を選択
                    </button>
                  </p>
                ))}
              </>
            )}
          </section>
          <fieldset disabled={readOnly}>
            <legend>条件別比較</legend>
            <label>
              実行する条件
              <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
                <option value="">現在の数量・単価</option>
                {document.scenarios.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              条件名
              <input value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} />
            </label>
            <button
              onClick={() =>
                void attempt(() => {
                  if (!scenarioName.trim()) throw Error('条件名を入力してください。');
                  const base = port.read();
                  editing(
                    {
                      ...base,
                      scenarios: [
                        ...base.scenarios,
                        {
                          id: newId('scenario'),
                          name: scenarioName,
                          quantities: base.quantities.flatMap((q) =>
                            (q.override?.value ?? q.value) === null
                              ? []
                              : [
                                  {
                                    id: q.id,
                                    value: q.override?.value ?? q.value!,
                                    reason: q.override?.reason ?? q.evidence,
                                  },
                                ],
                          ),
                          rates: base.rates.flatMap((r) =>
                            (r.override?.value ?? r.unitPrice) === null
                              ? []
                              : [
                                  {
                                    id: r.id,
                                    value: r.override?.value ?? r.unitPrice!,
                                    reason:
                                      r.override?.reason ??
                                      (r.evidence || '利用者が明示保存した単価条件'),
                                  },
                                ],
                          ),
                          workRules: structuredClone(base.workRules),
                          waste: base.lines.map((l) => ({ id: l.id, value: l.wasteRatio })),
                        },
                      ],
                    },
                    'Save estimate scenario',
                  );
                })
              }
            >
              現在の条件を保存
            </button>
            {document.scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  void attempt(() => {
                    editing(
                      {
                        ...port.read(),
                        scenarios: port.read().scenarios.filter((v) => v.id !== s.id),
                      },
                      'Delete scenario',
                    );
                    if (scenario === s.id) setScenario('');
                  })
                }
              >
                {s.name}を削除
              </button>
            ))}
          </fieldset>
          {candidate && (
            <section aria-label="見積提案差分">
              <h3>試算の比較</h3>
              <label>
                <input
                  type="checkbox"
                  checked={changedOnly}
                  onChange={(e) => setChangedOnly(e.target.checked)}
                />
                金額が変わった費目のみ
              </label>
              <p>
                採用まで見積内容を変更しません。数量・単価・ロス率・配賦・調整の条件を確認してください。
              </p>
              <p>
                変更前合計: {format(candidate.base.calculations.at(-1)?.result.total ?? '未計算')} →
                試算合計: {format(candidate.document.calculations.at(-1)!.result.total!)}{' '}
                {document.currency.code}
              </p>
              <EstimateBrowse
                label="試算"
                items={candidate.document.calculations.at(-1)!.result.lines}
              >
                {(items) => (
                  <div className="estimate-table">
                    <table>
                      <thead>
                        <tr>
                          <th>費目</th>
                          <th>数量</th>
                          <th>単価</th>
                          <th>単位</th>
                          <th>金額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((l) => (
                          <tr key={l.id}>
                            <th>{l.name}</th>
                            <td>{format(l.billableQuantity)}</td>
                            <td>{format(l.unitPrice)}</td>
                            <td>
                              {l.currency}/{l.unit}
                            </td>
                            <td>{format(l.cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </EstimateBrowse>
              {candidate.base.calculations.at(-1) &&
                canonicalJson(candidate.base.calculations.at(-1)!.basis.currency) ===
                  canonicalJson(candidate.document.calculations.at(-1)!.basis.currency) && (
                  <EstimateBrowse
                    label="増減内訳"
                    items={explained.filter((d) => !changedOnly || d.delta !== '0')}
                  >
                    {(items) => (
                      <div className="estimate-table">
                        <table aria-label="見積の増減内訳">
                          <thead>
                            <tr>
                              <th>費目</th>
                              <th>以前</th>
                              <th>試算</th>
                              <th>数量差</th>
                              <th>単価差</th>
                              <th>その他</th>
                              <th>差額</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((d) => (
                              <tr key={d.id}>
                                <th>{d.name}</th>
                                <td>{format(d.before?.cost ?? 'なし')}</td>
                                <td>{format(d.after?.cost ?? 'なし')}</td>
                                <td>{format(d.quantityDelta ?? '未算出')}</td>
                                <td>{format(d.rateDelta ?? '未算出')}</td>
                                <td>
                                  {format(
                                    d.otherDelta ?? ('diagnostic' in d ? d.diagnostic : '未算出'),
                                  )}
                                </td>
                                <td>{format(d.delta)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </EstimateBrowse>
                )}
              <p>
                丸め条件: {candidate.base.currency.code} / {candidate.base.currency.minorDigits}桁 /{' '}
                {candidate.base.rounding} → {candidate.document.currency.code} /{' '}
                {candidate.document.currency.minorDigits}桁 / {candidate.document.rounding}
              </p>
              <ul>
                {candidate.document.adjustments.map((a) => (
                  <li key={a.id}>
                    調整 {a.name}: {a.kind} {a.value} · 対象 {a.basisLineIds.length}費目 · 理由{' '}
                    {a.reason} · 計算額{' '}
                    {
                      candidate.document.calculations
                        .at(-1)!
                        .result.adjustments.find((r) => r.id === a.id)?.value
                    }
                  </li>
                ))}
              </ul>
              <button
                disabled={readOnly}
                onClick={() =>
                  void attempt(() => {
                    controller.apply(candidate);
                    setCandidate(undefined);
                    setSelectedCalculation('');
                    setStatus('試算を採用しました。');
                  })
                }
              >
                見積差分を採用
              </button>
              <button
                onClick={() => {
                  execution.current++;
                  controller.cancel();
                  setCandidate(undefined);
                }}
              >
                提案を破棄
              </button>
            </section>
          )}
          {calculation?.result.work && (
            <section aria-label="計算した工程案">
              <h3>計算した工程案</h3>
              <p>
                採用した計算の条件です。人員重複の調整は行いません。終了日は最終稼働日を表示します。
              </p>
              <EstimateBrowse
                label="工程"
                items={calculation.result.work.map((t) => ({
                  ...t,
                  category: calculation.basis.lines.find((l) => l.id === t.lineId)?.category,
                }))}
              >
                {(items) => (
                  <div className="estimate-table">
                    <table>
                      <thead>
                        <tr>
                          <th>工程</th>
                          <th>開始</th>
                          <th>最終稼働日</th>
                          <th>工数hour</th>
                          <th>人数・一日稼働</th>
                          <th>先行工程（FS）</th>
                          <th>根拠</th>
                          <th>稼働日数</th>
                          <th>種類</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((t) => (
                          <tr key={t.id}>
                            <th>{t.name}</th>
                            <td>{t.start}</td>
                            <td>{t.lastWorkingDate}</td>
                            <td>{format(t.effortHours)}</td>
                            <td>
                              {(() => {
                                const task = calculation.basis.workPlan?.tasks.find(
                                    (v) => v.id === t.id,
                                  ),
                                  rule = calculation.basis.workRules.find(
                                    (r) => r.id === task?.ruleId,
                                  );
                                return rule ? `${rule.crewCount}人 × ${rule.hoursPerDay}h/日` : '—';
                              })()}
                            </td>
                            <td>
                              {calculation.basis.workPlan?.dependencies
                                .filter((d) => d.after === t.id)
                                .map(
                                  (d) =>
                                    `${calculation.basis.workPlan?.tasks.find((v) => v.id === d.before)?.name ?? d.before} +${d.lag}稼働日`,
                                )
                                .join(' / ') || 'なし'}
                            </td>
                            <td>
                              <details>
                                <summary>数量・単価の根拠</summary>
                                <p>
                                  {JSON.stringify(
                                    calculation.basis.lines.find((l) => l.id === t.lineId)
                                      ?.bindings,
                                  )}
                                </p>
                                <p>
                                  {
                                    calculation.result.lines.find((l) => l.id === t.lineId)
                                      ?.billableQuantity
                                  }{' '}
                                  {calculation.result.lines.find((l) => l.id === t.lineId)?.unit}
                                </p>
                                <button
                                  disabled={
                                    readOnly || !document.lines.some((l) => l.id === t.lineId)
                                  }
                                  onClick={() => focusDiagnostic(t.lineId)}
                                >
                                  現在の費目を編集
                                </button>
                              </details>
                            </td>
                            <td>{t.durationWorkdays}</td>
                            <td>{t.kind}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </EstimateBrowse>
            </section>
          )}
          {calculation?.result.work && props.publication && (
            <section aria-label="工程の公開">
              <h3>通常Dataへの工程公開</h3>
              <p>見積の保存とDataの保存は別です。失敗時は表示を確認して再試行してください。</p>
              <button
                disabled={readOnly || verified !== signature}
                onClick={() =>
                  void attempt(async () => {
                    port.flush();
                    const c = await controller.verifiedCalculation(calculation.id);
                    await props.save();
                    setWorkPublication(await props.publication!.prepare(c));
                  })
                }
              >
                工程Dataの更新を確認
              </button>
              <button onClick={() => void attempt(() => props.publication?.openTarget?.())}>
                公開先Dataを開く
              </button>
              {workPublication && (
                <>
                  <ul>
                    {workPublication.changes.map((v, i) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                  {workPublication.conflicts.map((v, i) => (
                    <p role="alert" key={i}>
                      {v}
                    </p>
                  ))}
                  <button
                    disabled={readOnly || !!workPublication.conflicts.length}
                    onClick={() =>
                      void attempt(async () => {
                        port.flush();
                        await controller.verifiedCalculation(calculation.id);
                        await workPublication.apply();
                        setWorkPublication(undefined);
                        setStatus('工程Dataへの公開を保存しました。');
                      })
                    }
                  >
                    工程Dataへ採用・保存
                  </button>
                  <button onClick={() => setWorkPublication(undefined)}>工程公開を取消</button>
                </>
              )}
            </section>
          )}
          <section aria-label="見積結果">
            <h3>採用した計算結果</h3>
            <label>
              表示する計算
              <select
                value={calculation?.id ?? ''}
                onChange={(e) => setSelectedCalculation(e.target.value)}
              >
                {document.calculations.map((c, i) => (
                  <option value={c.id} key={c.id}>
                    計算 {i + 1} · {format(c.result.total!)} {c.basis.currency.code}
                  </option>
                ))}
              </select>
            </label>
            {calculation && (
              <>
                <p>
                  {historical || calculation.id !== document.calculations.at(-1)?.id
                    ? '過去の条件の結果'
                    : '現在の条件の採用結果'}{' '}
                  · {verified === signature ? '再計算照合済み' : '出力前の再検証が必要'}
                </p>
                <strong>
                  見積合計 {format(calculation.result.total!)} {calculation.basis.currency.code}
                </strong>
                <EstimateBrowse label="結果" items={orderedResults}>
                  {(items) => (
                    <>
                      <div className="estimate-mobile-results">
                        {items.map((l) => (
                          <article key={l.id}>
                            <strong>{l.name}</strong>
                            <p>
                              {format(l.cost)} {l.currency}
                            </p>
                            <p>
                              {format(l.billableQuantity)} {l.unit} × {format(l.unitPrice)}
                            </p>
                            <button disabled={readOnly} onClick={() => focusDiagnostic(l.id)}>
                              費目を編集
                            </button>
                          </article>
                        ))}
                      </div>
                      <div className="estimate-table estimate-result-table">
                        <table>
                          <thead>
                            <tr>
                              <th>費目</th>
                              <th>請求数量</th>
                              <th>単位</th>
                              <th>単価</th>
                              <th>丸め前</th>
                              <th>金額</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((l) => (
                              <tr key={l.id} onClick={() => props.select?.(l.id)}>
                                <th>{l.name}</th>
                                <td>{format(l.billableQuantity)}</td>
                                <td>{l.unit}</td>
                                <td>{format(l.unitPrice)}</td>
                                <td>{format(l.unroundedCost)}</td>
                                <td>{format(l.cost)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </EstimateBrowse>
                <p>
                  CSV・通常Dataコピーは全費目・調整・合計の静的出力。decimalはtextで精度を保持し、元見積へ追従しません。
                </p>
                <button
                  disabled={verified !== signature}
                  onClick={() =>
                    void attempt(async () => {
                      const c = await controller.verifiedCalculation(calculation.id),
                        out = estimateCsv(c);
                      download('estimate.csv', out.csv, 'text/csv');
                      download(
                        'estimate-manifest.json',
                        JSON.stringify(out.manifest, null, 2),
                        'application/json',
                      );
                    })
                  }
                >
                  CSV出力（静的）
                </button>
                <button
                  disabled={!props.copyData || verified !== signature}
                  onClick={() =>
                    void attempt(async () => {
                      const c = await controller.verifiedCalculation(calculation.id);
                      await props.copyData?.(
                        estimateData(c),
                        `estimate-copy-${c.id}-${c.basisHash}`,
                      );
                      setStatus('通常Dataへ静的コピーしました。');
                    })
                  }
                >
                  通常Dataへ静的コピー
                </button>
                <button
                  disabled={readOnly}
                  onClick={() =>
                    void attempt(() => {
                      editing(
                        {
                          ...port.read(),
                          calculations: port
                            .read()
                            .calculations.filter((c) => c.id !== calculation.id),
                        },
                        'Delete calculation',
                      );
                      setSelectedCalculation('');
                    })
                  }
                >
                  この計算記録を削除
                </button>
                <label>
                  比較元の計算
                  <select value={compare} onChange={(e) => setCompare(e.target.value)}>
                    <option value="">比較なし</option>
                    {document.calculations.map((c, i) => (
                      <option value={c.id} key={c.id}>
                        計算 {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
                {document.calculations.some(
                  (c) =>
                    c.id === compare &&
                    canonicalJson(c.basis.currency) === canonicalJson(calculation.basis.currency),
                ) && (
                  <div className="estimate-table">
                    <table aria-label="計算差額">
                      <thead>
                        <tr>
                          <th>費目</th>
                          <th>前の数量</th>
                          <th>後の数量</th>
                          <th>前の単価</th>
                          <th>後の単価</th>
                          <th>差額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {calculationDifference(
                          document.calculations.find((c) => c.id === compare)!,
                          calculation,
                        ).map((d) => (
                          <tr key={d.id}>
                            <th>{d.name}</th>
                            <td>{d.before?.billableQuantity ?? '追加'}</td>
                            <td>{d.after?.billableQuantity ?? '削除'}</td>
                            <td>{d.before?.unitPrice ?? '—'}</td>
                            <td>{d.after?.unitPrice ?? '—'}</td>
                            <td>{format(d.delta)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
