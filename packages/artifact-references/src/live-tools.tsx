import { useEffect, useMemo, useRef, useState } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { Dialog } from '@editor-platform/editor-ui';
import {
  prepareLiveReference,
  listLiveOptions,
  type LiveReference,
  type LiveReferenceProvider,
  type LiveTarget,
  type PreparedLiveReference,
  type ReferenceSnapshot,
  type ValueFormat,
  type ValueScale,
  VALUE_SCALES,
} from './index';
import {
  LiveReferenceDetails,
  LiveReferencePreview,
  LiveReferenceReview,
  liveReferenceMessage,
  type LiveReviewItem,
  type LiveReviewProps,
} from './live-review';
import './live-tools.css';

const SCALE_LABELS: Record<ValueScale, string> = { 3: '千', 4: '万', 6: '百万', 8: '億', 12: '兆' };

export interface LiveArtifactOption {
  artifactId: string;
  domain: string;
  label: string;
}

/** Local Surface connection. The Host supplies an authorized catalog of saved versions. */
export interface LiveReferenceConnection {
  destinationArtifactId: string;
  provider: LiveReferenceProvider;
  listArtifacts(): Promise<LiveArtifactOption[]>;
  listVersions(artifact: LiveArtifactOption): Promise<ReferenceSnapshot[]>;
  latest(reference: LiveReference): Promise<ReferenceSnapshot>;
}

type Insert = (reference: LiveReference, propose?: boolean) => void;
type CatalogState<T> = { load: () => Promise<T>; data?: T; error?: string };

function useCatalog<T>(load?: () => Promise<T>) {
  const [state, setState] = useState<CatalogState<T>>();
  useEffect(() => {
    if (!load) return;
    let active = true;
    void Promise.resolve()
      .then(load)
      .then(
        (data) => {
          if (active) setState({ load, data });
        },
        (err: unknown) => {
          if (active) setState({ load, error: liveReferenceMessage(err) });
        },
      );
    return () => {
      active = false;
    };
  }, [load]);
  return state?.load === load ? state : undefined;
}

const unique = (values: string[]) => [...new Set(values)];
const savedLabel = (snapshot: ReferenceSnapshot) =>
  `保存版 ${snapshot.revision} · ${snapshot.versionId}`;

function LiveReferencePicker({
  connection,
  insert,
  close,
  readOnly,
  canPropose,
}: {
  connection: LiveReferenceConnection;
  insert: Insert;
  close(): void;
  readOnly?: boolean;
  canPropose?: boolean;
}) {
  const [kind, setKind] = useState<LiveTarget['kind']>('value');
  const [artifactId, setArtifactId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [scenario, setScenario] = useState('');
  const [optionId, setOptionId] = useState('');
  const [format, setFormat] = useState<ValueFormat>({ style: 'decimal', digits: 2, unit: '' });
  const [preview, setPreview] = useState<PreparedLiveReference>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const doInsert = useRef(insert);
  doInsert.current = insert;
  const artifacts = useCatalog(connection.listArtifacts);
  const artifact = artifacts?.data?.find((candidate) => candidate.artifactId === artifactId);
  const loadVersions = useMemo(
    () => (artifact ? () => connection.listVersions(artifact) : undefined),
    [artifact, connection],
  );
  const versions = useCatalog(loadVersions);
  const snapshot = versions?.data?.find((candidate) => candidate.versionId === versionId);
  const loadOptions = useMemo(
    () => (snapshot ? () => listLiveOptions(snapshot, connection.provider) : undefined),
    [snapshot, connection],
  );
  const options = useCatalog(loadOptions);
  const values =
    options?.data?.flatMap((option) => (option.kind === 'value' ? [option] : [])) ?? [];
  const figures =
    options?.data?.flatMap((option) => (option.kind === 'figure' ? [option] : [])) ?? [];
  const target: LiveTarget | undefined =
    kind === 'value'
      ? values.find((option) => option.targetId === scenario && option.metricId === optionId)
      : figures.find((option) => option.figureId === optionId);
  function revise(change: () => void) {
    change();
    setPreview(undefined);
    setError('');
  }
  async function resolve(action: 'preview' | 'apply' | 'propose') {
    if (!snapshot || !artifact || !target || busy || readOnly) return;
    setError('');
    setBusy(true);
    try {
      const source = {
        artifactId: artifact.artifactId,
        domain: artifact.domain,
        target:
          target.kind === 'value'
            ? { kind: 'value' as const, targetId: target.targetId, metricId: target.metricId }
            : { kind: 'figure' as const, figureId: target.figureId },
      };
      const prepared = await prepareLiveReference(
        source,
        snapshot,
        connection.provider,
        kind === 'value' ? format : undefined,
        connection.destinationArtifactId,
      );
      if (!active.current) return;
      if (action !== 'preview') {
        if (canonicalJson(prepared) !== canonicalJson(preview))
          throw new Error('引用の表示が変わりました。もう一度プレビューしてください。');
        doInsert.current(prepared.reference, action === 'propose');
        close();
      } else setPreview(prepared);
    } catch (err) {
      if (active.current) {
        setError(liveReferenceMessage(err));
        setPreview(undefined);
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <Dialog
      title="引用の挿入"
      onClose={() => {
        active.current = false;
        close();
      }}
    >
      <div className="ep-live-picker">
        <p>元の成果物 → 保存済み版 → {kind === 'value' ? '値 → 書式' : '図'}</p>
        <fieldset disabled={busy || readOnly}>
          <label>
            引用の種類
            <select
              value={kind}
              onChange={(e) =>
                revise(() => {
                  setKind(e.target.value === 'figure' ? 'figure' : 'value');
                  setScenario('');
                  setOptionId('');
                })
              }
            >
              <option value="value">値</option>
              <option value="figure">図</option>
            </select>
          </label>
          <label>
            元の成果物
            <select
              value={artifactId}
              onChange={(e) =>
                revise(() => {
                  setArtifactId(e.target.value);
                  setVersionId('');
                  setScenario('');
                  setOptionId('');
                })
              }
            >
              <option value="">成果物を選ぶ</option>
              {artifacts?.data
                ?.filter((entry) => entry.artifactId !== connection.destinationArtifactId)
                .map((entry) => (
                  <option key={entry.artifactId} value={entry.artifactId}>
                    {entry.label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            保存済み版
            <select
              value={versionId}
              disabled={!artifact}
              onChange={(e) =>
                revise(() => {
                  setVersionId(e.target.value);
                  setScenario('');
                  setOptionId('');
                })
              }
            >
              <option value="">保存済み版を選ぶ</option>
              {versions?.data?.map((entry) => (
                <option key={entry.versionId} value={entry.versionId}>
                  {savedLabel(entry)}
                </option>
              ))}
            </select>
          </label>
          {kind === 'value' ? (
            <>
              <label>
                シナリオ
                <select
                  value={scenario}
                  disabled={!snapshot}
                  onChange={(e) =>
                    revise(() => {
                      setScenario(e.target.value);
                      setOptionId('');
                    })
                  }
                >
                  <option value="">シナリオを選ぶ</option>
                  {unique(values.map(({ targetId }) => targetId)).map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
              <label>
                指標
                <select
                  value={optionId}
                  disabled={!scenario}
                  onChange={(e) => revise(() => setOptionId(e.target.value))}
                >
                  <option value="">指標を選ぶ</option>
                  {values
                    .filter(({ targetId }) => targetId === scenario)
                    .map(({ metricId, label }) => (
                      <option key={metricId} value={metricId}>
                        {label || metricId}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                書式
                <select
                  value={format.style}
                  onChange={(e) =>
                    revise(() =>
                      setFormat(
                        e.target.value === 'percent'
                          ? (({ scale: _scale, ...rest }) => ({
                              ...rest,
                              style: 'percent' as const,
                            }))(format)
                          : { ...format, style: 'decimal' },
                      ),
                    )
                  }
                >
                  <option value="decimal">小数</option>
                  <option value="percent">パーセント</option>
                </select>
              </label>
              <label>
                桁数
                <select
                  value={format.digits}
                  onChange={(e) =>
                    revise(() => setFormat({ ...format, digits: Number(e.target.value) }))
                  }
                >
                  {Array.from({ length: 7 }, (_, digits) => (
                    <option key={digits}>{digits}</option>
                  ))}
                </select>
              </label>
              <label>
                倍率
                <select
                  value={format.scale ?? ''}
                  disabled={format.style === 'percent'}
                  onChange={(e) =>
                    revise(() => {
                      const { scale: _scale, ...rest } = format;
                      const scale = Number(e.target.value) as ValueScale;
                      setFormat(
                        (VALUE_SCALES as readonly number[]).includes(scale)
                          ? { ...rest, scale }
                          : rest,
                      );
                    })
                  }
                >
                  <option value="">なし</option>
                  {VALUE_SCALES.map((scale) => (
                    <option key={scale} value={scale}>
                      {SCALE_LABELS[scale]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={!!format.grouping}
                  onChange={(e) =>
                    revise(() => {
                      const { grouping: _grouping, ...rest } = format;
                      setFormat(e.target.checked ? { ...rest, grouping: true } : rest);
                    })
                  }
                />
                桁区切り
              </label>
              <label>
                単位
                <input
                  value={format.unit}
                  maxLength={256}
                  onChange={(e) => revise(() => setFormat({ ...format, unit: e.target.value }))}
                />
              </label>
              {format.scale !== undefined &&
                !format.unit.trim().startsWith(SCALE_LABELS[format.scale]) && (
                  <p className="ep-live-hint" role="note">
                    倍率を選んでも単位は変わりません。単位を「{SCALE_LABELS[format.scale]}
                    円」のように書いてください。
                  </p>
                )}
            </>
          ) : (
            <label>
              図
              <select
                value={optionId}
                disabled={!snapshot}
                onChange={(e) => revise(() => setOptionId(e.target.value))}
              >
                <option value="">図を選ぶ</option>
                {figures.map(({ figureId, label }) => (
                  <option key={figureId} value={figureId}>
                    {label || figureId}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {snapshot && options?.data && !(kind === 'value' ? values.length : figures.length) && (
          <p role="status">
            この保存済み版には選べる{kind === 'value' ? '値' : '図'}がありません。
          </p>
        )}
        {(error || options?.error || versions?.error || artifacts?.error) && (
          <p role="alert">{error || options?.error || versions?.error || artifacts?.error}</p>
        )}
        {preview && (
          <div aria-label="引用のプレビュー">
            <LiveReferencePreview {...preview} />
          </div>
        )}
        <div className="ep-live-actions">
          <button
            type="button"
            disabled={!target || busy || readOnly}
            onClick={() => void resolve('preview')}
          >
            プレビュー
          </button>
          <button
            type="button"
            disabled={!preview || busy || readOnly}
            onClick={() => void resolve('apply')}
          >
            挿入する
          </button>
          {canPropose && (
            <button
              type="button"
              disabled={!preview || busy || readOnly}
              onClick={() => void resolve('propose')}
            >
              挿入を提案
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              active.current = false;
              close();
            }}
          >
            取り消す
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function LiveReferenceTools({
  connection,
  items,
  selected,
  readOnly,
  disabledReason,
  captureInsert,
  change,
  canPropose,
  removeLabel = '引用を外す',
  onNewer,
}: {
  connection?: LiveReferenceConnection;
  items: LiveReviewItem[];
  selected?: LiveReviewItem;
  readOnly?: boolean;
  disabledReason?: string;
  captureInsert(): Insert;
  change(item: LiveReviewItem, replacement?: LiveReference, propose?: boolean): void;
  canPropose?: boolean;
  removeLabel?: string;
  onNewer: NonNullable<LiveReviewProps['onNewer']>;
}) {
  const [picker, setPicker] = useState<{ connection: LiveReferenceConnection; insert: Insert }>();
  const [error, setError] = useState('');
  const current = useRef({ connection, readOnly, disabledReason });
  current.current = { connection, readOnly, disabledReason };
  if (!connection && !items.length) return null;
  function act(action: () => void) {
    setError('');
    try {
      action();
    } catch (err) {
      setError(liveReferenceMessage(err));
    }
  }
  const disabled = readOnly || !!disabledReason;
  const actions = (
    <>
      <button
        type="button"
        disabled={disabled || !connection}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() =>
          act(() => {
            if (connection) setPicker({ connection, insert: captureInsert() });
          })
        }
      >
        引用を挿入
      </button>
      <button
        type="button"
        disabled={disabled || !selected}
        onClick={() =>
          act(() => {
            if (selected) change(selected);
          })
        }
      >
        {removeLabel}
      </button>
      {canPropose && (
        <button
          type="button"
          disabled={disabled || !selected}
          onClick={() =>
            act(() => {
              if (selected) change(selected, undefined, true);
            })
          }
        >
          削除を提案
        </button>
      )}
    </>
  );
  return (
    <div className="ep-live-tools" aria-label="生きた引用">
      {selected && <LiveReferenceDetails reference={selected.reference} />}
      {(disabled || !connection) && (
        <p role="status">
          {disabledReason ||
            (readOnly
              ? '読み取り専用では挿入・更新・削除は利用できません。'
              : '引用元への接続が必要です。')}
        </p>
      )}
      {connection ? (
        <LiveReferenceReview
          {...connection}
          items={items}
          readOnly={disabled}
          update={change}
          propose={canPropose ? (item, replacement) => change(item, replacement, true) : undefined}
          onNewer={onNewer}
          actions={actions}
        />
      ) : (
        <div className="ep-live-actions">{actions}</div>
      )}
      {error && <p role="alert">{error}</p>}
      {picker && picker.connection === connection && (
        <LiveReferencePicker
          connection={picker.connection}
          readOnly={disabled}
          canPropose={canPropose}
          close={() => setPicker(undefined)}
          insert={(reference, propose) => {
            if (
              current.current.readOnly ||
              current.current.disabledReason ||
              current.current.connection !== picker.connection
            )
              throw new Error('編集できる状態に戻してから挿入してください。');
            picker.insert(reference, propose);
          }}
        />
      )}
    </div>
  );
}
