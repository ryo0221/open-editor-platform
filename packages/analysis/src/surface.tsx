import { ExpressionEditor, roundingModes } from './expression-editor';
import { DifferenceTable, ResultTable, ResultChart, runLabel, displayValue } from './result-view';
import { BufferedText } from './buffered-text';
import { useEffect, useMemo, useRef, useState } from 'react';
import { canonicalJson, newId } from '@editor-platform/artifact-core';
import { type EditorInputBoundary } from '@editor-platform/editor-core';
import { expressionType, decimalType, type Expression } from '@editor-platform/calculation-core';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import {
  assertAnalysis,
  restoreAnalysisInputs,
  type inspectAnalysisJoins,
  assertAnalysisAccess,
  retainData,
  recipeFields,
  analysisDiff,
  duplicateAnalysisStep,
  moveAnalysisStep,
  runDiff,
  resultCsv,
  resultData,
  type AnalysisDocument,
  type Step,
} from '@editor-platform/analysis-core';
import {
  AnalysisController,
  type AnalysisPort,
  type AnalysisCandidate,
  type AnalysisWorkerFactory,
} from './host';
import { type AnalysisSourceOption } from './sources';
export interface AnalysisSurfaceProps {
  port: AnalysisPort;
  sources: AnalysisSourceOption[];
  worker?: AnalysisWorkerFactory;
  registerInput?(boundary: EditorInputBoundary): () => void;
  save(): Promise<void>;
  history(direction: 'undo' | 'redo'): void;
  copyData?(data: StructuredData, requestId: string): Promise<void>;
  select?(id: string): void;
  openSource?(artifactId: string): void;
}
const mappingKey = (input: AnalysisDocument['inputs'][number]) =>
  canonicalJson([input.id, input.snapshotKey]);
const download = (name: string, text: string, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export function AnalysisSurface(props: AnalysisSurfaceProps) {
  const latest = useRef(props);
  latest.current = props;
  const pendingText = useRef(new Set<string>());
  const stepBuffer = useRef({ dirty: false, committing: false });
  const [stepDirty, setStepDirty] = useState(false);
  const textCommit = useRef(false);
  const buffer = useRef({ dirty: false, composing: false, committing: false, text: '' });
  const [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<AnalysisCandidate>(),
    [sourceIndex, setSourceIndex] = useState(0),
    [columns, setColumns] = useState<string[]>([]);
  const [operation, setOperation] = useState<Step['op']>('derive'),
    [input, setInput] = useState(''),
    [fieldId, setFieldId] = useState(''),
    [expression, setExpression] = useState(
      '{"op":"literal","type":{"kind":"decimal","unit":"dimensionless"},"value":"1"}',
    );
  const [expressionMode, setExpressionMode] = useState<'form' | 'json'>('form');
  const [visualExpression, setVisualExpression] = useState<Expression>({
    op: 'literal',
    type: decimalType(),
    value: '1',
  });
  const [editingStep, setEditingStep] = useState('');
  const [groupBy, setGroupBy] = useState<string[]>([]),
    [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc'),
    [presentation, setPresentation] = useState<'table' | 'chart'>('table');
  const [scale, setScale] = useState(6),
    [rounding, setRounding] =
      useState<import('@editor-platform/calculation-core').Rounding>('half-even');
  const [cardinality, setCardinality] = useState<'1:1' | 'many:1'>('many:1');
  const [inspectionCode, setInspectionCode] = useState<
    '' | 'duplicate-key' | 'null-key' | 'unmatched-key'
  >('');
  const [inspectionOffset, setInspectionOffset] = useState(0);
  const [inspection, setInspection] = useState<{
    signature: string;
    report: ReturnType<typeof inspectAnalysisJoins>;
  }>();
  const [label, setLabel] = useState('Result'),
    [aggregate, setAggregate] = useState('sum'),
    [right, setRight] = useState(''),
    [rightKey, setRightKey] = useState(''),
    [joinMode, setJoinMode] = useState<'inner' | 'left'>('left');
  const [mappingTexts, setMappingTexts] = useState<Record<string, string>>({}),
    [compareRun, setCompareRun] = useState('');
  const [scenario, setScenario] = useState(''),
    [selectedRun, setSelectedRun] = useState(''),
    [recipeText, setRecipeText] = useState(''),
    [verified, setVerified] = useState('');
  const document = props.port.read(),
    readOnly = !props.port.canEdit();
  const port = useMemo<AnalysisPort>(
    () => ({
      read: () => latest.current.port.read(),
      revision: () => latest.current.port.revision(),
      generation: () => latest.current.port.generation(),
      canEdit: () => latest.current.port.canEdit(),
      canRead: (p) => latest.current.port.canRead(p),
      canExport: () => latest.current.port.canExport(),
      inputsReady: () =>
        !buffer.current.composing &&
        (!stepBuffer.current.dirty || stepBuffer.current.committing) &&
        (pendingText.current.size === 0 || textCommit.current) &&
        (!buffer.current.dirty || buffer.current.committing) &&
        latest.current.port.inputsReady(),
      execute: (c) => latest.current.port.execute(c),
      flush: () => {
        if (stepBuffer.current.dirty && !stepBuffer.current.committing)
          throw Error('処理stepを確定するか、未確定の編集を取消してください。');
        commitBuffer.current();
        latest.current.port.flush();
      },
    }),
    [],
  );
  const registerBoundary = useMemo(
    () => (b: EditorInputBoundary) => latest.current.registerInput?.(b) ?? (() => {}),
    [],
  );
  const controller = useMemo(
    () => new AnalysisController(port, props.worker),
    [port, props.worker],
  );
  const commitBuffer = useRef<() => void>(() => {});
  commitBuffer.current = () => {
    if (buffer.current.composing) throw Error('IME変換を確定してください。');
    if (!buffer.current.dirty) return;
    const next = JSON.parse(buffer.current.text) as unknown;
    assertAnalysis(next);
    buffer.current.committing = true;
    try {
      controller.edit(next, 'Edit analysis conditions');
      buffer.current.dirty = false;
    } finally {
      buffer.current.committing = false;
    }
  };
  useEffect(() => () => controller.close(), [controller]);
  useEffect(
    () =>
      props.registerInput?.({
        label: '分析条件',
        read: () => ({ dirty: buffer.current.dirty, composing: buffer.current.composing }),
        prepare: () => {
          if (buffer.current.composing) throw Error('IME変換を確定してください。');
          if (buffer.current.dirty) assertAnalysis(JSON.parse(buffer.current.text));
          return () => commitBuffer.current();
        },
        focus: () => {},
      }),
    [props.registerInput],
  );
  useEffect(
    () =>
      props.registerInput?.({
        label: '処理stepの編集',
        read: () => ({ dirty: stepBuffer.current.dirty, composing: buffer.current.composing }),
        prepare: () => {
          if (stepBuffer.current.dirty && !stepBuffer.current.committing)
            throw Error('処理stepを確定するか、未確定の編集を取消してください。');
          return () => {};
        },
        focus: () => {},
      }),
    [props.registerInput],
  );
  const attempt = async (action: () => void | Promise<void>) => {
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const edit = (next: AnalysisDocument, label: string) =>
    attempt(() => {
      port.flush();
      controller.edit(next, label);
    });
  const source = props.sources[sourceIndex];
  const sourceData = source && isStructuredData(source.content) ? source.content : undefined;
  const tables = recipeFields(document, document),
    inputId = input || document.steps.at(-1)?.id || document.inputs[0]?.id || '',
    fields = tables.get(inputId) ?? [];
  const currentRun = document.runs.find((r) => r.id === selectedRun) ?? document.runs.at(-1);
  let readable = true;
  try {
    assertAnalysisAccess(document, props.port);
  } catch {
    readable = false;
  }
  const signature = canonicalJson([document, props.port.generation(), readable]);
  useEffect(() => {
    let active = true;
    setVerified('');
    if (currentRun && readable)
      void controller
        .verifiedOutput(currentRun.id, Object.keys(currentRun.results)[0])
        .then(() => {
          if (active) setVerified(signature);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [signature, currentRun?.id, controller, readable]);
  async function addInput() {
    if (!source) throw Error('保存済みDataを選択してください。');
    const base = structuredClone(port.read()),
      revision = port.revision();
    const retained = await retainData(source.pin, source.content, columns);
    if (revision !== port.revision()) throw Error('入力取得中にノートが変更されました。');
    const existing = base.retainedSources.find((s) => s.key === retained.key);
    if (existing && canonicalJson(existing.table) !== canonicalJson(retained.table))
      throw Error('同じ版は保持した列選択で使用してください。');
    controller.edit(
      {
        ...base,
        inputs: [
          ...base.inputs,
          {
            id: newId('input'),
            name: source.label,
            snapshotKey: retained.key,
            selectedColumnIds: columns,
          },
        ],
        retainedSources: existing ? base.retainedSources : [...base.retainedSources, retained],
      },
      'Add saved Data input',
    );
  }
  function addStep() {
    // flush may have committed a pending title/note through another input boundary.
    const document = port.read(),
      tables = recipeFields(document, document),
      inputId = input || document.steps.at(-1)?.id || document.inputs[0]?.id || '',
      fields = tables.get(inputId) ?? [];
    const id = editingStep || newId('step'),
      target = fieldId || fields[0]?.id,
      chosen = fields.find((f) => f.id === target);
    const env = {
      fields: Object.fromEntries(fields.map((f) => [f.id, f.type])),
      parameters: Object.fromEntries(document.parameters.map((p) => [p.id, p.type])),
    };
    let step: Step;
    if (operation === 'derive') {
      const expr = JSON.parse(expression) as Expression;
      step = {
        id,
        op: 'derive',
        input: inputId,
        expression: expr,
        field: {
          id:
            document.steps.find((s) => s.id === editingStep && s.op === 'derive')?.op === 'derive'
              ? (
                  document.steps.find((s) => s.id === editingStep) as Extract<
                    Step,
                    { op: 'derive' }
                  >
                ).field.id
              : newId('field'),
          label,
          type: expressionType(expr, env),
        },
      };
    } else if (operation === 'filter')
      step = { id, op: 'filter', input: inputId, expression: JSON.parse(expression) };
    else if (operation === 'select')
      step = {
        id,
        op: 'select',
        input: inputId,
        columns: fields
          .filter((f) => selectedFields.includes(f.id))
          .map((f) => ({ sourceId: f.id, field: f })),
      };
    else if (operation === 'sort')
      step = { id, op: 'sort', input: inputId, keys: [{ fieldId: target, direction }] };
    else if (operation === 'join') {
      const rightFields = tables.get(right) ?? [];
      step = {
        id,
        op: 'join',
        input: inputId,
        right,
        leftKey: target,
        rightKey,
        mode: joinMode,
        cardinality,
        columns: rightFields.map((f) => ({ sourceId: f.id, field: { ...f, id: newId('field') } })),
      };
    } else {
      const type = aggregate.startsWith('count') ? decimalType('count') : chosen?.type;
      if (!type) throw Error('集計列を選択してください。');
      step = {
        id,
        op: 'aggregate',
        input: inputId,
        groupBy,
        metrics: [
          {
            field: { id: newId('field'), label, type },
            operation: aggregate as 'sum',
            ...(aggregate === 'countRows' ? {} : { fieldId: target }),
            ...(aggregate === 'mean' ? { scale, rounding } : {}),
          },
        ],
      };
    }
    const next = {
        ...document,
        steps: editingStep
          ? document.steps.map((s) => (s.id === editingStep ? step : s))
          : [...document.steps, step],
      },
      outFields = recipeFields(next, next).get(id)!;
    controller.edit(
      editingStep
        ? next
        : {
            ...next,
            outputs: [
              ...next.outputs,
              {
                id: newId('output'),
                stepId: id,
                columns: outFields.map((f) => f.id),
                presentation,
              },
            ],
          },
      'Add analysis step',
    );
    setInput(id);
    setEditingStep('');
    setGroupBy([]);
    setSelectedFields([]);
  }
  async function trialUpdate(inputId: string) {
    const updateRevision = port.revision();
    const base = port.read(),
      i = base.inputs.find((v) => v.id === inputId)!;
    const old = base.retainedSources.find((s) => s.key === i.snapshotKey)!;
    const update = latest.current.sources.find(
      (s) =>
        s.latest &&
        s.pin.artifactId === old.pin.artifactId &&
        s.pin.versionId !== old.pin.versionId,
    );
    if (!update) throw Error('新しい保存版はありません。');
    const mapping = JSON.parse(mappingTexts[mappingKey(i)] ?? '{}') as Record<string, string>;
    if (
      !mapping ||
      typeof mapping !== 'object' ||
      Array.isArray(mapping) ||
      Object.entries(mapping).some(
        ([key, value]) => !i.selectedColumnIds.includes(key) || typeof value !== 'string',
      )
    )
      throw Error('旧列ID→新列IDのmappingを指定してください。');
    const selectedColumns = i.selectedColumnIds.map((id) => mapping[id] ?? id);
    const retained = await retainData(update.pin, update.content, selectedColumns);
    for (const f of old.table.fields)
      if (
        canonicalJson(f.type) !==
        canonicalJson(
          retained.table.fields.find((n) => n.id === (mapping[f.id] ?? f.id))?.type ?? null,
        )
      )
        throw Error(
          `列 ${f.id} の型が変わりました。同じ型の列への対応を選ぶか、処理の型・単位変換を見直してください。`,
        );
    const next = {
      ...base,
      inputs: base.inputs.map((v) =>
        v.id === inputId
          ? {
              ...v,
              snapshotKey: retained.key,
              selectedColumnIds: selectedColumns,
              columnMapping: Object.fromEntries(
                selectedColumns.map((id, index) => [
                  id,
                  i.columnMapping?.[i.selectedColumnIds[index]] ?? i.selectedColumnIds[index],
                ]),
              ),
            }
          : v,
      ),
      retainedSources: base.retainedSources.some((s) => s.key === retained.key)
        ? base.retainedSources
        : [...base.retainedSources, retained],
    };
    if (updateRevision !== port.revision()) throw Error('新版取得中にノートが変更されました。');
    setCandidate(await controller.prepare(scenario || null, next));
  }
  async function inspect(offset = 0) {
    const report = await controller.inspect(scenario || null, {
      offset,
      code: inspectionCode || undefined,
    });
    setInspectionOffset(offset);
    setInspection({ signature: signature + scenario + inspectionCode, report });
  }
  return (
    <section
      className="ep-analysis"
      aria-label="計算・分析ノート"
      onCompositionStart={() => {
        buffer.current.composing = true;
      }}
      onCompositionEnd={() => {
        buffer.current.composing = false;
      }}
    >
      <header>
        <h2>{document.title}</h2>
        <p>保存したDataの版に固定して計算します。新版は試算・確認後に採用します。</p>
        <div
          className="analysis-actions"
          // Keep the native input focused until the action flushes its registered boundary.
          // A blur-triggered commit can move the toolbar between mouse down and click.
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            disabled={readOnly || busy}
            onClick={() =>
              void attempt(async () => {
                setBusy(true);
                try {
                  await controller.run(scenario || null);
                  setSelectedRun('');
                  setCompareRun('');
                  setStatus('結果を採用しました。保存すると参照先で利用できます。');
                } finally {
                  setBusy(false);
                }
              })
            }
          >
            実行
          </button>
          <button
            disabled={!busy}
            onClick={() => {
              controller.cancel();
              setBusy(false);
            }}
          >
            取消
          </button>
          <button
            disabled={readOnly}
            onClick={() =>
              void attempt(() => {
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
        <p role="alert">入力への閲覧権限がありません。入力と派生結果を非表示にしました。</p>
      ) : (
        <>
          <div className="analysis-columns">
            <div>
              <fieldset disabled={readOnly || busy}>
                <legend>ノート</legend>
                <BufferedText
                  label="タイトル"
                  value={document.title}
                  register={registerBoundary}
                  changed={(id, dirty) => {
                    if (dirty) pendingText.current.add(id);
                    else pendingText.current.delete(id);
                  }}
                  onError={setError}
                  commit={(title) => {
                    textCommit.current = true;
                    try {
                      controller.edit({ ...port.read(), title }, 'Rename notebook');
                    } finally {
                      textCommit.current = false;
                    }
                  }}
                />
                <BufferedText
                  label="説明"
                  value={document.blocks.find((b) => b.kind === 'note')?.text ?? ''}
                  multiline
                  register={registerBoundary}
                  changed={(id, dirty) => {
                    if (dirty) pendingText.current.add(id);
                    else pendingText.current.delete(id);
                  }}
                  onError={setError}
                  commit={(text) => {
                    textCommit.current = true;
                    try {
                      const current = port.read(),
                        note = current.blocks.find((b) => b.kind === 'note');
                      controller.edit(
                        {
                          ...current,
                          blocks: [
                            ...current.blocks.filter((b) => b.kind !== 'note'),
                            { id: note?.id ?? newId('note'), kind: 'note', text, targetId: null },
                          ],
                        },
                        'Edit note',
                      );
                    } finally {
                      textCommit.current = false;
                    }
                  }}
                />
              </fieldset>
              <fieldset disabled={readOnly || busy}>
                <legend>保存済みDataの入力</legend>
                <label>
                  入力版
                  <select
                    value={sourceIndex}
                    onChange={(e) => {
                      setSourceIndex(Number(e.target.value));
                      setColumns([]);
                    }}
                  >
                    {props.sources.map((s, i) => (
                      <option value={i} key={canonicalJson(s.pin)}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  {sourceData?.columns.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={columns.includes(c.id)}
                        onChange={(e) =>
                          setColumns(
                            e.target.checked
                              ? [...columns, c.id]
                              : columns.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name} ({c.type})
                    </label>
                  ))}
                </div>
                <button onClick={() => void attempt(addInput)}>入力を追加</button>
                {document.inputs.map((i) => {
                  const retained = document.retainedSources.find((s) => s.key === i.snapshotKey)!;
                  return (
                    <article key={i.id}>
                      <strong>{i.name}</strong>
                      <details>
                        <summary>現在の保存版ID</summary>
                        {retained.pin.versionId}
                      </details>
                      {(() => {
                        const update = props.sources.find(
                          (s) =>
                            s.latest &&
                            s.pin.artifactId === retained.pin.artifactId &&
                            s.pin.versionId !== retained.pin.versionId,
                        );
                        if (!update || !isStructuredData(update.content)) return null;
                        const nextColumns = update.content.columns;
                        let mapping: Record<string, string> = {};
                        try {
                          mapping = JSON.parse(mappingTexts[mappingKey(i)] ?? '{}');
                        } catch {
                          /* Advanced input remains subject to validation. */
                        }
                        return (
                          <fieldset>
                            <legend>新版の列対応（安定IDを明示）</legend>
                            <label>
                              新版の列mapping（{i.name}・旧ID→新ID）
                              <textarea
                                value={mappingTexts[mappingKey(i)] ?? '{}'}
                                onChange={(e) =>
                                  setMappingTexts({
                                    ...mappingTexts,
                                    [mappingKey(i)]: e.target.value,
                                  })
                                }
                              />
                            </label>
                            {i.selectedColumnIds.map((id) => (
                              <label key={id}>
                                {retained.table.fields.find((f) => f.id === id)?.label} · {id}
                                <select
                                  aria-label={`新版の対応列 ${id}`}
                                  value={
                                    mapping?.[id] ??
                                    (nextColumns.some((c) => c.id === id) ? id : '')
                                  }
                                  onChange={(e) =>
                                    setMappingTexts({
                                      ...mappingTexts,
                                      [mappingKey(i)]: JSON.stringify({
                                        ...mapping,
                                        [id]: e.target.value,
                                      }),
                                    })
                                  }
                                >
                                  <option value="">対応先を選択</option>
                                  {nextColumns.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name} · {c.id} ({c.type})
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ))}
                          </fieldset>
                        );
                      })()}
                      <button onClick={() => props.openSource?.(retained.pin.artifactId)}>
                        元データへ
                      </button>
                      <button
                        onClick={() =>
                          void attempt(async () => {
                            setBusy(true);
                            try {
                              await trialUpdate(i.id);
                            } finally {
                              setBusy(false);
                            }
                          })
                        }
                      >
                        新版で試算
                      </button>
                    </article>
                  );
                })}
              </fieldset>
              <fieldset disabled={readOnly || busy}>
                <legend>Parameterと条件別比較</legend>
                {document.parameters.map((p) => (
                  <BufferedText
                    key={p.id}
                    label={p.label + ' · ' + p.id}
                    value={String(p.value ?? '')}
                    register={registerBoundary}
                    changed={(id, dirty) => {
                      if (dirty) pendingText.current.add(id);
                      else pendingText.current.delete(id);
                    }}
                    onError={setError}
                    commit={(value) => {
                      if (p.type.kind === 'boolean' && !['true', 'false'].includes(value))
                        throw Error(
                          'boolean parameterはtrueまたはfalseを指定してください。nullは条件JSONで指定します。',
                        );
                      textCommit.current = true;
                      try {
                        const current = port.read();
                        controller.edit(
                          {
                            ...current,
                            parameters: current.parameters.map((v) =>
                              v.id === p.id
                                ? {
                                    ...v,
                                    value: p.type.kind === 'boolean' ? value === 'true' : value,
                                  }
                                : v,
                            ),
                          },
                          'Set parameter',
                        );
                      } finally {
                        textCommit.current = false;
                      }
                    }}
                  />
                ))}
                <button
                  onClick={() =>
                    void edit(
                      {
                        ...document,
                        parameters: [
                          ...document.parameters,
                          {
                            id: newId('parameter'),
                            label: '係数',
                            type: decimalType(),
                            value: '1',
                          },
                        ],
                      },
                      'Add parameter',
                    )
                  }
                >
                  Parameterを追加
                </button>
                <label>
                  実行条件
                  <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
                    <option value="">現在のparameter</option>
                    {document.scenarios.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() =>
                    void edit(
                      {
                        ...document,
                        scenarios: [
                          ...document.scenarios,
                          {
                            id: newId('scenario'),
                            name: `条件 ${document.scenarios.length + 1}`,
                            parameterValues: Object.fromEntries(
                              document.parameters.map((p) => [p.id, p.value]),
                            ),
                          },
                        ],
                      },
                      'Save scenario',
                    )
                  }
                >
                  現在のparameterを条件として保存
                </button>
              </fieldset>
            </div>
            <div>
              <button
                onClick={() => {
                  stepBuffer.current.dirty = false;
                  setStepDirty(false);
                  setEditingStep('');
                  setInput('');
                  setOperation('derive');
                  const expr: Expression = { op: 'literal', type: decimalType(), value: '1' };
                  setExpression(JSON.stringify(expr));
                  setVisualExpression(expr);
                  setExpressionMode('form');
                  setGroupBy([]);
                  setSelectedFields([]);
                  setLabel('Result');
                  setFieldId('');
                  setAggregate('sum');
                  setRight('');
                  setRightKey('');
                  setJoinMode('left');
                  setDirection('asc');
                  setPresentation('table');
                  setScale(6);
                  setRounding('half-even');
                  setCardinality('many:1');
                }}
              >
                未確定の編集を取消
              </button>
              <fieldset
                disabled={readOnly || busy}
                onChange={() => {
                  stepBuffer.current.dirty = true;
                  setStepDirty(true);
                }}
              >
                <legend>処理step</legend>
                {stepDirty && (
                  <p>未確定の処理stepがあります。確定または取消後に実行・保存できます。</p>
                )}

                <label>
                  処理入力
                  <select
                    disabled={!!editingStep}
                    value={inputId}
                    onChange={(e) => {
                      setInput(e.target.value);
                      setGroupBy([]);
                      setSelectedFields([]);
                      setFieldId('');
                    }}
                  >
                    {[
                      ...document.inputs.map((i) => ({ id: i.id, label: i.name })),
                      ...document.steps.map((s) => ({ id: s.id, label: s.op })),
                    ].map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} · {v.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  演算
                  <select
                    disabled={!!editingStep}
                    value={operation}
                    onChange={(e) => setOperation(e.target.value as Step['op'])}
                  >
                    {['select', 'filter', 'derive', 'aggregate', 'sort', 'join'].map((op) => (
                      <option key={op}>{op}</option>
                    ))}
                  </select>
                </label>
                <label>
                  列
                  <select
                    value={fieldId || fields[0]?.id || ''}
                    onChange={(e) => setFieldId(e.target.value)}
                  >
                    {fields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label} · {f.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  結果列名
                  <input value={label} onChange={(e) => setLabel(e.target.value)} />
                </label>
                {(operation === 'filter' || operation === 'derive') && (
                  <>
                    <label>
                      式の編集方法
                      <select
                        value={expressionMode}
                        onChange={(e) => {
                          if (e.target.value === 'form') {
                            void attempt(() => {
                              const parsed = JSON.parse(expression);
                              expressionType(parsed, {
                                fields: Object.fromEntries(fields.map((f) => [f.id, f.type])),
                                parameters: Object.fromEntries(
                                  document.parameters.map((p) => [p.id, p.type]),
                                ),
                              });
                              setVisualExpression(parsed);
                              setExpressionMode('form');
                            });
                          } else setExpressionMode('json');
                        }}
                      >
                        <option value="form">式ビルダー</option>
                        <option value="json">高度なJSON</option>
                      </select>
                    </label>
                    {expressionMode === 'form' ? (
                      <ExpressionEditor
                        value={visualExpression}
                        change={(e) => {
                          setVisualExpression(e);
                          setExpression(JSON.stringify(e));
                        }}
                        fields={fields}
                        parameters={document.parameters}
                      />
                    ) : (
                      <label>
                        型付き式（JSON AST）
                        <textarea
                          value={expression}
                          onChange={(e) => setExpression(e.target.value)}
                        />
                      </label>
                    )}
                    <button
                      onClick={() => {
                        const expr: Expression = { op: 'literal', type: decimalType(), value: '1' };
                        setVisualExpression(expr);
                        setExpression(JSON.stringify(expr));
                        setExpressionMode('form');
                        stepBuffer.current.dirty = true;
                        setStepDirty(true);
                      }}
                    >
                      式を初期化
                    </button>
                  </>
                )}
                {operation === 'aggregate' && (
                  <>
                    <fieldset>
                      <legend>グループ列</legend>
                      {fields.map((f) => (
                        <label key={f.id}>
                          <input
                            type="checkbox"
                            checked={groupBy.includes(f.id)}
                            onChange={(e) =>
                              setGroupBy(
                                e.target.checked
                                  ? [...groupBy, f.id]
                                  : groupBy.filter((id) => id !== f.id),
                              )
                            }
                          />
                          {f.label}
                        </label>
                      ))}
                    </fieldset>
                    <label>
                      集計
                      <select value={aggregate} onChange={(e) => setAggregate(e.target.value)}>
                        {['sum', 'min', 'max', 'mean', 'countRows', 'countNonNull'].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                    {aggregate === 'mean' && (
                      <>
                        <label>
                          平均の小数桁
                          <input
                            type="number"
                            min="0"
                            max="18"
                            value={scale}
                            onChange={(e) => setScale(Number(e.target.value))}
                          />
                        </label>
                        <label>
                          平均の丸め方法
                          <select
                            value={rounding}
                            onChange={(e) => setRounding(e.target.value as typeof rounding)}
                          >
                            {roundingModes.map((v) => (
                              <option key={v}>{v}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                  </>
                )}
                {operation === 'select' && (
                  <fieldset>
                    <legend>出力する列</legend>
                    {fields.map((f) => (
                      <label key={f.id}>
                        <input
                          type="checkbox"
                          checked={selectedFields.includes(f.id)}
                          onChange={(e) =>
                            setSelectedFields(
                              e.target.checked
                                ? [...selectedFields, f.id]
                                : selectedFields.filter((id) => id !== f.id),
                            )
                          }
                        />
                        {f.label}
                      </label>
                    ))}
                  </fieldset>
                )}
                {operation === 'sort' && (
                  <label>
                    並び順
                    <select
                      value={direction}
                      onChange={(e) => setDirection(e.target.value as typeof direction)}
                    >
                      <option value="asc">昇順</option>
                      <option value="desc">降順</option>
                    </select>
                  </label>
                )}
                {!editingStep && (
                  <label>
                    表示形式
                    <select
                      value={presentation}
                      onChange={(e) => setPresentation(e.target.value as typeof presentation)}
                    >
                      <option value="table">結果表</option>
                      <option value="chart">結果表とChart</option>
                    </select>
                  </label>
                )}
                {operation === 'join' && (
                  <>
                    <label>
                      右入力
                      <select value={right} onChange={(e) => setRight(e.target.value)}>
                        <option value="">選択</option>
                        {[...tables.keys()].map((id) => (
                          <option key={id}>{id}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      右key
                      <select value={rightKey} onChange={(e) => setRightKey(e.target.value)}>
                        <option value="">選択</option>
                        {tables.get(right)?.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      結合
                      <select
                        value={joinMode}
                        onChange={(e) => setJoinMode(e.target.value as 'left' | 'inner')}
                      >
                        <option>left</option>
                        <option>inner</option>
                      </select>
                    </label>
                    <label>
                      結合の多重度
                      <select
                        value={cardinality}
                        onChange={(e) => setCardinality(e.target.value as typeof cardinality)}
                      >
                        <option>many:1</option>
                        <option>1:1</option>
                      </select>
                    </label>
                    <p>右key重複を拒否し、null同士は結合しません。</p>
                  </>
                )}
                <button
                  onClick={() =>
                    void attempt(() => {
                      stepBuffer.current.committing = true;
                      try {
                        port.flush();
                        addStep();
                        stepBuffer.current.dirty = false;
                        setStepDirty(false);
                      } finally {
                        stepBuffer.current.committing = false;
                      }
                    })
                  }
                >
                  {editingStep ? '式の変更を確定' : 'Stepを追加'}
                </button>
                {editingStep && (
                  <button
                    onClick={() => {
                      setEditingStep('');
                      setInput('');
                      stepBuffer.current.dirty = false;
                      setStepDirty(false);
                    }}
                  >
                    式の編集を取消
                  </button>
                )}
              </fieldset>
              <ol>
                {document.steps.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => props.select?.(s.id)}>
                      {s.op} ·{' '}
                      {s.op === 'derive'
                        ? s.field.label
                        : `処理 ${document.steps.findIndex((v) => v.id === s.id) + 1}`}
                    </button>
                    <small>
                      入力: {document.inputs.find((i) => i.id === s.input)?.name ?? s.input}
                    </small>
                    {(s.op === 'derive' || s.op === 'filter') && (
                      <button
                        disabled={readOnly || busy}
                        onClick={() => {
                          setEditingStep(s.id);
                          setOperation(s.op);
                          setInput(s.input);
                          setExpression(JSON.stringify(s.expression));
                          setVisualExpression(s.expression);
                          setExpressionMode('form');
                          if (s.op === 'derive') setLabel(s.field.label);
                        }}
                      >
                        式を編集
                      </button>
                    )}
                    <button
                      disabled={readOnly}
                      onClick={() =>
                        void attempt(() =>
                          controller.edit(
                            duplicateAnalysisStep(port.read(), s.id),
                            'Duplicate step',
                          ),
                        )
                      }
                    >
                      複製
                    </button>
                    <button
                      disabled={readOnly || document.steps[0].id === s.id}
                      onClick={() =>
                        void attempt(() =>
                          controller.edit(moveAnalysisStep(port.read(), s.id, -1), 'Move step'),
                        )
                      }
                    >
                      上へ
                    </button>
                    <button
                      disabled={readOnly || document.steps.at(-1)?.id === s.id}
                      onClick={() =>
                        void attempt(() =>
                          controller.edit(moveAnalysisStep(port.read(), s.id, 1), 'Move step'),
                        )
                      }
                    >
                      下へ
                    </button>
                    <button
                      disabled={readOnly}
                      onClick={() =>
                        void edit(
                          {
                            ...document,
                            steps: document.steps.filter((v) => v.id !== s.id),
                            outputs: document.outputs.filter((o) => o.stepId !== s.id),
                          },
                          'Remove step',
                        )
                      }
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ol>
              <details>
                <summary>条件JSONを編集（複製・並替・mapping・Chart設定）</summary>
                <button
                  onClick={() => {
                    const text = JSON.stringify(port.read(), null, 2);
                    setRecipeText(text);
                    buffer.current.text = text;
                  }}
                >
                  現在の条件を読む
                </button>
                <textarea
                  aria-label="条件JSON"
                  value={recipeText}
                  disabled={readOnly}
                  onChange={(e) => {
                    setRecipeText(e.target.value);
                    buffer.current.text = e.target.value;
                    buffer.current.dirty = true;
                  }}
                />
                <button
                  disabled={readOnly}
                  onClick={() => void attempt(() => commitBuffer.current())}
                >
                  条件を確定
                </button>
                <button
                  onClick={() => {
                    buffer.current.dirty = false;
                    setRecipeText('');
                  }}
                >
                  編集を取消
                </button>
              </details>
            </div>
          </div>
          <section aria-label="結合データの診断">
            <h3>結合データの診断</h3>
            <label>
              診断の種類
              <select
                value={inspectionCode}
                onChange={(e) => {
                  setInspectionCode(e.target.value as typeof inspectionCode);
                  setInspection(undefined);
                  setInspectionOffset(0);
                }}
              >
                <option value="">すべて</option>
                <option value="duplicate-key">重複キー</option>
                <option value="null-key">nullキー</option>
                <option value="unmatched-key">未結合キー</option>
              </select>
            </label>
            <button disabled={busy} onClick={() => void attempt(() => inspect())}>
              重複・未結合キーを調べる
            </button>
            {inspection?.signature === signature + scenario + inspectionCode && (
              <>
                <p>
                  {inspection.report.total}
                  項目中{inspectionOffset + (inspection.report.findings.length ? 1 : 0)}〜
                  {inspectionOffset + inspection.report.findings.length}
                  項目（1ページ200項目・各100行IDまで表示）。診断は結果を採用しません。停止したstepより後は未検査です。
                </p>
                <button
                  disabled={busy || inspectionOffset === 0}
                  onClick={() => void attempt(() => inspect(Math.max(0, inspectionOffset - 200)))}
                >
                  前の診断
                </button>
                <button
                  disabled={busy || inspectionOffset + 200 >= inspection.report.total}
                  onClick={() => void attempt(() => inspect(inspectionOffset + 200))}
                >
                  次の診断
                </button>
                {inspection.report.error && <p>計算停止: {inspection.report.error}</p>}
                <div className="analysis-table">
                  <table>
                    <thead>
                      <tr>
                        <th>問題</th>
                        <th>キー</th>
                        <th>安定行ID</th>
                        <th>処理と入力</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspection.report.findings.map((f, index) => (
                        <tr key={index}>
                          <td>
                            {
                              {
                                'duplicate-key': '重複キー',
                                'null-key': 'nullキー',
                                'unmatched-key': '未結合キー',
                              }[f.code]
                            }
                          </td>
                          <td>{displayValue(f.key)}</td>
                          <td>{f.rowIds.join(', ')}</td>
                          <td>
                            {f.stepId} / {f.side === 'left' ? '左入力' : '右入力'}
                            <button
                              onClick={() => {
                                const visit = (id: string): void => {
                                  const i = document.inputs.find((i) => i.id === id);
                                  if (i) {
                                    const retained = document.retainedSources.find(
                                      (s) => s.key === i.snapshotKey,
                                    );
                                    if (retained) props.openSource?.(retained.pin.artifactId);
                                  } else {
                                    const step = document.steps.find((s) => s.id === id);
                                    if (step) visit(step.input);
                                  }
                                };
                                visit(f.inputId);
                              }}
                            >
                              元データへ移動
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
          {candidate && (
            <section aria-label="提案差分">
              <h3>新版の試算差分</h3>
              <DifferenceTable
                changes={analysisDiff(candidate.base, candidate.document)}
                document={candidate.document}
                label="入力更新の比較表"
              />
              <button
                disabled={readOnly}
                onClick={() =>
                  void attempt(() => {
                    controller.apply(candidate);
                    setCandidate(undefined);
                  })
                }
              >
                差分を採用
              </button>
              <button
                onClick={() => {
                  controller.cancel();
                  setCandidate(undefined);
                }}
              >
                提案を破棄
              </button>
            </section>
          )}
          <section aria-label="計算結果">
            <h3>計算結果</h3>
            {currentRun && (
              <>
                <p>
                  {currentRun.id !== document.runs.at(-1)?.id && '過去結果を表示中 — '}
                  {runLabel(currentRun, document)} —
                  過去結果の閲覧だけでは現在の入力は変わりません。
                </p>
                <button
                  disabled={readOnly || busy}
                  onClick={() =>
                    void attempt(() => {
                      port.flush();
                      controller.edit(
                        restoreAnalysisInputs(port.read(), currentRun.id),
                        'Restore successful input versions',
                      );
                      setStatus('入力版と列対応を復旧しました。現在の条件で再実行してください。');
                    })
                  }
                >
                  この成功runの入力版に戻す
                </button>
              </>
            )}
            <label>
              比較元run
              <select value={compareRun} onChange={(e) => setCompareRun(e.target.value)}>
                <option value="">比較しない</option>
                {document.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r, document)}
                  </option>
                ))}
              </select>
            </label>
            {currentRun && document.runs.some((r) => r.id === compareRun) && (
              <DifferenceTable
                changes={runDiff(document.runs.find((r) => r.id === compareRun)!, currentRun)}
                document={document}
                label="条件別差分"
              />
            )}
            <label>
              過去run
              <select value={currentRun?.id ?? ''} onChange={(e) => setSelectedRun(e.target.value)}>
                {document.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r, document)}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {verified === signature
                ? '再計算照合済み。入力版・条件は各runに保持しています。'
                : '未検証 — 検証完了まで出力できません。'}
            </p>
            {currentRun &&
              Object.entries(currentRun.results).map(([id, table]) => (
                <article key={id}>
                  <h4>
                    {table.fields.map((f) => f.label).join(' / ')} · {table.rows.length}件
                  </h4>
                  <details>
                    <summary>入力版・実行IDの詳細</summary>
                    <p>{currentRun.id}</p>
                    {currentRun.basis.inputs.map((i) => (
                      <p key={i.id}>
                        {i.name}:{' '}
                        {
                          document.retainedSources.find((s) => s.key === i.snapshotKey)?.pin
                            .versionId
                        }
                      </p>
                    ))}
                  </details>
                  <ResultTable key={currentRun.id + id} table={table} select={props.select} />
                  {currentRun.basis.outputs.find((o) => o.id === id)?.presentation === 'chart' && (
                    <ResultChart table={table} />
                  )}
                  <p>CSV・Dataコピーは検索条件に関係なく全{table.rows.length}件を出力します。</p>
                  <p>
                    CSV・Dataコピーは独立した静的データです。元の分析を変更しても更新されません。decimalはDataではtext列として精度を保持します。Chartは近似描画です。正式な値は結果表で確認してください。
                  </p>
                  <p>{table.diagnostics.map((d) => `${d.code}: ${d.count}`).join(', ')}</p>
                  <button
                    disabled={verified !== signature}
                    onClick={() =>
                      void attempt(async () => {
                        const { table } = await controller.verifiedOutput(currentRun.id, id);
                        const out = resultCsv(table);
                        download('analysis.csv', out.csv, 'text/csv');
                        download('analysis-manifest.json', JSON.stringify(out.manifest, null, 2));
                      })
                    }
                  >
                    CSV出力（静的）
                  </button>
                  <button
                    disabled={!props.copyData || verified !== signature}
                    onClick={() =>
                      void attempt(async () => {
                        const { table } = await controller.verifiedOutput(currentRun.id, id);
                        await props.copyData!(resultData(table), newId('analysis-copy'));
                        setStatus('独立したDataへコピーしました。数値は精度を保つtext列です。');
                      })
                    }
                  >
                    通常Dataへ静的コピー
                  </button>
                </article>
              ))}
          </section>
        </>
      )}
    </section>
  );
}
