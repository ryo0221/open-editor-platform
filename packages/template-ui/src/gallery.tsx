import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { clone } from '@editor-platform/artifact-core';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import {
  TemplateCatalog,
  expandTemplate,
  type StructureLayout,
  inputDefaults,
  prepareInstantiation,
  prepareInsertion,
  preparePreset,
  localTemplateSnapshot,
  previewSharedTemplate,
  applySharedTemplate,
  prepareViewPreset,
  importTemplatePack,
  exportTemplatePack,
  TemplateError,
  domains,
  type Domain,
  type TemplateKind,
  type TemplateDefinition,
  type NativeContent,
  type InputValue,
  type Diagnostic,
  type PreparedCreation,
  type PreparedApplication,
  type CatalogAdapter,
  type TemplateTarget,
} from '@editor-platform/templates';
import { TemplateInputForm } from './form';
import { TemplatePreview } from './preview';
export interface TemplateGalleryProps {
  catalog: TemplateCatalog;
  local?: CatalogAdapter;
  kind: TemplateKind;
  initialDomain?: Domain;
  readOnly?: boolean;
  target?: {
    artifactId: string;
    domain: Domain;
    content: NativeContent;
    ids: string[];
    afterId?: string;
    shared?: SharedEditorSession<NativeContent>;
  };
  onCreate?(prepared: PreparedCreation): Promise<void>;
  onApply?(prepared: PreparedApplication): Promise<void> | void;
  onViewSettings?(domain: Domain, settings: Record<string, InputValue>): void;
  onClose(): void;
  /** Optional Host-owned deterministic client. It receives the same schema and returns only input data. */
  agentInputs?(definition: TemplateDefinition): Promise<Record<string, InputValue>>;
}
type Prepared =
  | { creation: PreparedCreation; content: NativeContent }
  | { application: PreparedApplication; content: NativeContent; token?: string }
  | { settings: Record<string, InputValue>; content?: undefined };
function recent() {
  try {
    return JSON.parse(localStorage.getItem('ep-template-recent') ?? '[]') as string[];
  } catch {
    return [];
  }
}
function remember(id: string) {
  try {
    localStorage.setItem(
      'ep-template-recent',
      JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 12)),
    );
  } catch {
    /* optional preference */
  }
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TemplateGallery(props: TemplateGalleryProps) {
  const { catalog, local, kind, target, onClose } = props;
  const [domain, setDomain] = useState<Domain | ''>(target?.domain ?? props.initialDomain ?? '');
  const [query, setQuery] = useState(''),
    [unit, setUnit] = useState(''),
    [category, setCategory] = useState(''),
    [recentOnly, setRecent] = useState(false);
  const [items, setItems] = useState<TemplateDefinition[]>([]),
    [selected, setSelected] = useState<TemplateDefinition>(),
    [values, setValues] = useState<Record<string, InputValue>>({}),
    [prepared, setPrepared] = useState<Prepared>(),
    [error, setError] = useState(''),
    [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]),
    [busy, setBusy] = useState(false),
    [sampleRows, setSampleRows] = useState(true),
    [scope, setScope] = useState<'selection' | 'artifact'>('selection'),
    [mapping, setMapping] = useState<TemplateTarget['fieldMapping']>({});
  const working = useRef(false),
    errorNotice = useRef<HTMLParagraphElement>(null),
    drafts = useRef(new Map<string, Record<string, InputValue>>());
  useEffect(() => {
    if (!error) return;
    // The dialog heading is sticky. Reveal the first notice below it, including
    // after an apply at the bottom of a long preview, and announce keyboard focus.
    errorNotice.current?.focus({ preventScroll: true });
    errorNotice.current?.closest('dialog')?.scrollTo({ top: 0 });
  }, [error]);
  const reload = () =>
    catalog
      .list({ kind, domain: domain || undefined, search: query, category: category || undefined })
      .then(setItems)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    let active = true;
    void catalog
      .list({ kind, domain: domain || undefined, search: query, category: category || undefined })
      .then((values) => {
        if (active) setItems(values);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [catalog, domain, query, category, kind]);
  const select = (d: TemplateDefinition) => {
    setSelected(d);
    setValues(
      clone(
        drafts.current.get(`${d.templateId}@${d.templateVersion}`) ?? {
          ...inputDefaults(d.inputs),
          ...d.sample,
        },
      ),
    );
    setPrepared(undefined);
    setError('');
    setDiagnostics([]);
    setMapping({});
  };
  const update = (next: Record<string, InputValue>) => {
    if (selected?.structure) {
      const slot = selected.repeats[selected.structure.repeat].slot;
      const items = next[slot];
      if (Array.isArray(items))
        next = {
          ...next,
          [slot]: items.map((item) =>
            item &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            !Object.hasOwn(item, selected.structure!.itemId)
              ? { ...item, [selected.structure!.itemId]: `i-${crypto.randomUUID()}` }
              : item,
          ),
        };
    }
    setValues(next);
    if (selected) drafts.current.set(`${selected.templateId}@${selected.templateVersion}`, next);
    setPrepared(undefined);
    setDiagnostics([]);
  };
  const run = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof TemplateError) setDiagnostics(e.diagnostics);
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const preview = async (input = values) =>
    run(async () => {
      if (!selected) return;
      setPrepared(undefined);
      setDiagnostics([]);
      if (kind === 'whole') {
        if (props.readOnly) throw new Error('Read only');
        const creation = await prepareInstantiation(selected, input, crypto.randomUUID(), {
          includeSampleRows: sampleRows,
        });
        setPrepared({ creation, content: creation.artifact.draft.content });
        return;
      }
      if (!target) throw new Error('Open a compatible artifact first');
      if (['review', 'file'].includes(target.domain)) {
        setPrepared({ settings: await prepareViewPreset(selected, input) });
        return;
      }
      if (props.readOnly) throw new Error('Read only');
      const state =
          target.shared?.confirmed ??
          localTemplateSnapshot(target.artifactId, target.domain, target.content),
        identity = target.shared?.adapter.identity ?? {
          actorId: 'local',
          clientId: 'local',
          sessionId: 'local',
        };
      const options: TemplateTarget = {
        ids: target.ids,
        scope,
        afterId: target.afterId,
        fieldMapping: mapping,
        position: ['whiteboard', 'design'].includes(target.domain)
          ? insertionPosition(target.content)
          : undefined,
      };
      const application = await (kind === 'fragment' ? prepareInsertion : preparePreset)(
        selected,
        input,
        state,
        identity,
        options,
      );
      const sharedPreview = target.shared
        ? await previewSharedTemplate(application, target.shared)
        : undefined;
      setPrepared({
        application,
        content: sharedPreview?.after ?? application.preview,
        token: sharedPreview?.token,
      });
    });
  useEffect(() => {
    if (selected && selected.domain !== 'data') void preview();
  }, [selected]);
  const vary = (count: number, layout?: StructureLayout) => {
    if (!selected?.structure) return;
    const slot = selected.repeats[selected.structure.repeat].slot,
      old = values[slot] as Record<string, InputValue>[];
    const sample = selected.sample[slot] as Record<string, InputValue>[];
    const next = {
      ...values,
      [slot]: Array.from(
        { length: count },
        (_, i) =>
          old[i] ?? {
            ...clone(sample[i % sample.length]),
            id: `item-${i + 1}`,
            ...(typeof sample[i % sample.length].title === 'string'
              ? {
                  title: `${String(sample[i % sample.length].title).replace(/\s+\d+$/, '')} ${i + 1}`,
                }
              : {}),
          },
      ),
      [selected.structure.layoutSlot]: layout ?? values[selected.structure.layoutSlot],
    };
    update(next);
    if (selected.domain !== 'data') void preview(next);
  };
  let mappingContent = selected?.content;
  if (selected?.structure && selected.domain === 'data') {
    try {
      mappingContent = expandTemplate(selected, values, { remap: false }).content;
    } catch {
      /* input diagnostics appear on preparation */
    }
  }
  const apply = () =>
    run(async () => {
      if (!prepared || !selected) return;
      if (props.readOnly && !('settings' in prepared)) throw new Error('Read only');
      if ('creation' in prepared) {
        if (!props.onCreate) throw new Error('This Host does not allow creation');
        await props.onCreate(prepared.creation);
      } else if ('application' in prepared) {
        if (target?.shared) {
          await applySharedTemplate(prepared.application, target.shared, prepared.token!);
          await props.onApply?.(prepared.application);
        } else {
          if (!props.onApply) throw new Error('This Host does not allow insertion');
          await props.onApply(prepared.application);
        }
      } else props.onViewSettings?.(selected.domain, prepared.settings);
      remember(selected.templateId);
      onClose();
    });
  const categories = [...new Set(items.map((d) => d.category))];
  return (
    <Dialog
      title={
        kind === 'whole'
          ? 'テンプレートから作成'
          : kind === 'fragment'
            ? '部分テンプレートを挿入'
            : 'スタイル・表示プリセット'
      }
      onClose={onClose}
    >
      <div className="tp-gallery">
        {error && (
          <p className="tp-error" role="alert" ref={errorNotice} tabIndex={-1}>
            {error}
          </p>
        )}
        {!selected ? (
          <>
            <div className="tp-filters">
              <label>
                検索
                <input
                  aria-label="テンプレート検索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label>
                Editor
                <select
                  aria-label="テンプレートのEditor"
                  value={domain}
                  disabled={!!target}
                  onChange={(e) => setDomain(e.target.value as Domain | '')}
                >
                  <option value="">すべて</option>
                  {domains
                    .filter((d) => kind === 'preset' || !['review', 'file'].includes(d))
                    .map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                </select>
              </label>
              <label>
                カテゴリー
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">すべて</option>
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                再利用単位
                <select
                  aria-label="テンプレートの再利用単位"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                >
                  <option value="">すべて</option>
                  {[...new Set(items.map(unitLabel))].map((label) => (
                    <option key={label}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={recentOnly}
                  onChange={(e) => setRecent(e.target.checked)}
                />
                最近使ったもの
              </label>
            </div>
            <div className="tp-cards">
              {items
                .filter((d) => !recentOnly || recent().includes(d.templateId))
                .filter((d) => !unit || unitLabel(d) === unit)
                .map((d) => (
                  <TemplateCard key={d.templateId} definition={d} onSelect={() => select(d)} />
                ))}
            </div>
            {local && (
              <label className="tp-import">
                テンプレートpackを読み込む
                <input
                  type="file"
                  aria-label="テンプレートpackを読み込む"
                  accept=".json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file)
                      void run(async () => {
                        await importTemplatePack(await file.text(), local);
                        await reload();
                      });
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </>
        ) : (
          <>
            <div className="tp-selected-heading">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSelected(undefined);
                  setPrepared(undefined);
                }}
              >
                ← 一覧に戻る
              </button>
              <div>
                <h3>{selected.name}</h3>
                <p>{selected.purpose}</p>
                <p>
                  {unitLabel(selected)}。
                  {kind === 'fragment'
                    ? '追加後は成果物上で直接編集できます。'
                    : kind === 'whole'
                      ? '新しい成果物を作成します。'
                      : '選択範囲のスタイル・個人表示設定を適用します。'}
                </p>
                {selected.composition && (
                  <p>
                    {selected.kind === 'whole' ? 'Template' : 'Pattern'} · リンク{' '}
                    {selected.composition.members.filter((m) => m.reuse === 'linked').length}部品 /
                    コピー {selected.composition.members.filter((m) => m.reuse === 'copy').length}
                    部品。本文・画像は公開入力で変更できます。
                  </p>
                )}
              </div>
              <label>
                版
                <select
                  aria-label="テンプレートの版"
                  disabled={busy}
                  value={selected.templateVersion}
                  onChange={(e) =>
                    void run(async () =>
                      select(await catalog.getVersion(selected.templateId, Number(e.target.value))),
                    )
                  }
                >
                  {Array.from(
                    {
                      length:
                        items.find((d) => d.templateId === selected.templateId)?.templateVersion ??
                        selected.templateVersion,
                    },
                    (_, i) => (
                      <option key={i} value={i + 1}>
                        v{i + 1}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <button
                type="button"
                onClick={() =>
                  void run(async () =>
                    download(
                      `${selected.templateId}-v${selected.templateVersion}.template.json`,
                      await exportTemplatePack([selected]),
                    ),
                  )
                }
              >
                packを書き出す
              </button>
            </div>
            {selected.structure && (
              <fieldset className="tp-variants" disabled={busy}>
                <legend>同じ構成の変化を確認</legend>
                {[2, 3, 4]
                  .filter((n) => n <= selected.structure!.max)
                  .map((n) => (
                    <button key={n} type="button" onClick={() => vary(n)}>
                      {n}項目
                    </button>
                  ))}
                <label>
                  配置
                  <select
                    aria-label="挿入前の配置"
                    value={String(values[selected.structure.layoutSlot])}
                    onChange={(e) =>
                      vary(
                        (values[selected.repeats[selected.structure!.repeat].slot] as InputValue[])
                          .length,
                        e.target.value as StructureLayout,
                      )
                    }
                  >
                    {selected.inputs
                      .find((f) => f.key === selected.structure!.layoutSlot)
                      ?.options?.map((o) => (
                        <option key={o} value={o}>
                          {o === 'auto' ? '自動' : o === 'horizontal' ? '横' : '縦'}
                        </option>
                      ))}
                  </select>
                </label>
              </fieldset>
            )}
            <div className="tp-workspace">
              <fieldset className="tp-form-column tp-form-fields" disabled={busy}>
                <details open={!selected.structure}>
                  <summary>挿入前に内容を指定する（任意）</summary>
                  <TemplateInputForm
                    fields={selected.inputs}
                    assets={selected.assets}
                    values={values}
                    onChange={update}
                    diagnostics={diagnostics}
                  />
                </details>
                {selected.domain === 'data' && kind === 'whole' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={sampleRows}
                      onChange={(e) => {
                        setSampleRows(e.target.checked);
                        setPrepared(undefined);
                      }}
                    />
                    初期レコードを含める
                  </label>
                )}
                {kind === 'preset' && !['review', 'file'].includes(selected.domain) && (
                  <label>
                    適用範囲
                    <select
                      aria-label="プリセットの適用範囲"
                      value={scope}
                      onChange={(e) => {
                        setScope(e.target.value as 'selection' | 'artifact');
                        setPrepared(undefined);
                      }}
                    >
                      <option value="selection">選択した要素のみ</option>
                      <option value="artifact">成果物全体</option>
                    </select>
                  </label>
                )}
                {kind === 'fragment' &&
                  selected.domain === 'data' &&
                  target &&
                  'columns' in target.content &&
                  mappingContent &&
                  'columns' in mappingContent && (
                    <fieldset>
                      <legend>field mapping</legend>
                      {mappingContent.columns.map((c) => (
                        <label key={c.id}>
                          {c.name} ({c.type})
                          <select
                            aria-label={`Map ${c.name}`}
                            value={
                              typeof mapping?.[c.id] === 'string' ? (mapping[c.id] as string) : ''
                            }
                            onChange={(e) => {
                              setMapping({
                                ...mapping,
                                [c.id]: e.target.value || { newName: c.name },
                              });
                              setPrepared(undefined);
                            }}
                          >
                            <option value="">新しいfieldを追加 / 明示mapping未選択</option>
                            {('columns' in target.content ? target.content.columns : []).map(
                              (t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name} ({t.type}) · {t.id.slice(-6)}
                                </option>
                              ),
                            )}
                          </select>
                          {typeof mapping?.[c.id] !== 'string' && (
                            <input
                              aria-label={`New field name ${c.name}`}
                              value={
                                (mapping?.[c.id] as { newName: string } | undefined)?.newName ??
                                c.name
                              }
                              onChange={(e) => {
                                setMapping({ ...mapping, [c.id]: { newName: e.target.value } });
                                setPrepared(undefined);
                              }}
                            />
                          )}
                        </label>
                      ))}
                    </fieldset>
                  )}
                <div className="tp-actions">
                  <button type="button" disabled={busy} onClick={() => void preview()}>
                    入力内容をプレビュー
                  </button>
                  {props.agentInputs && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const next = await props.agentInputs!(selected);
                          update(next);
                        })
                      }
                    >
                      模擬agentの入力を使う
                    </button>
                  )}
                </div>
              </fieldset>
              <div className="tp-preview-column">
                <h4>{prepared ? '適用する内容' : '完成サンプル'}</h4>
                {prepared ? (
                  <>
                    {'application' in prepared &&
                      prepared.application.notices.map((notice) => <p key={notice}>{notice}</p>)}
                    <TemplatePreview
                      key={`prepared-${selected.templateId}`}
                      domain={selected.domain}
                      content={prepared.content}
                      settings={'settings' in prepared ? prepared.settings : undefined}
                    />
                    {'application' in prepared && prepared.application.mapping.length > 0 && (
                      <table>
                        <thead>
                          <tr>
                            <th>元のfield</th>
                            <th>適用先</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {prepared.application.mapping.map((m) => (
                            <tr key={m.sourceId}>
                              <td>
                                {m.sourceName} ({m.sourceType})
                              </td>
                              <td>{m.targetName}</td>
                              <td>{m.action}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <button
                      className="primary tp-apply"
                      type="button"
                      disabled={busy}
                      onClick={() => void apply()}
                    >
                      {kind === 'whole'
                        ? 'この内容で作成'
                        : kind === 'fragment'
                          ? selected.structure
                            ? `${selected.structure.unit}を追加`
                            : 'この内容を挿入'
                          : 'この設定を適用'}
                    </button>
                  </>
                ) : (
                  <SamplePreview
                    definition={selected}
                    inputs={selected.structure ? values : undefined}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
function SamplePreview({
  definition: d,
  compact = false,
  inputs,
}: {
  definition: TemplateDefinition;
  compact?: boolean;
  inputs?: Record<string, InputValue>;
}) {
  try {
    const expanded = expandTemplate(d, inputs ?? d.sample);
    return (
      <TemplatePreview
        domain={d.domain}
        content={expanded.content}
        settings={expanded.settings?.fields}
        compact={compact}
      />
    );
  } catch (e) {
    return <p role="alert">{(e as Error).message}</p>;
  }
}
function TemplateCard({
  definition: d,
  onSelect,
}: {
  definition: TemplateDefinition;
  onSelect(): void;
}) {
  return (
    <article className="tp-card" onClick={onSelect}>
      <div className="tp-card-art" inert aria-hidden="true">
        <SamplePreview definition={d} compact />
      </div>
      <button type="button" aria-label={`テンプレートを選択: ${d.name}`}>
        <strong>{d.name}</strong>
        <small>
          {d.domain} · {unitLabel(d)} · v{d.templateVersion}
        </small>
        <span>{d.purpose}</span>
        <small>
          {d.structure
            ? `${d.structure.min}〜${d.structure.max}項目・追加後も変更可能`
            : '内容指定は任意'}{' '}
          ·{' '}
          {d.kind === 'whole'
            ? '全体セットを新規作成'
            : d.kind === 'fragment'
              ? `${unitLabel(d)}を追加`
              : 'スタイル・表示設定を適用'}
        </small>
      </button>
    </article>
  );
}
export function unitLabel(d: TemplateDefinition) {
  if (d.kind === 'whole') return '全体セット';
  if (d.kind === 'preset')
    return ['review', 'file'].includes(d.domain) ? '表示・注釈作成の設定' : '選択範囲のスタイル';
  return (
    d.structure?.unit ??
    {
      slide: 'ページ・ページ内の部品',
      whiteboard: 'セクション・図解',
      design: 'フレーム・部品群',
      document: '本文・表・注意書き',
      data: '列・ビュー',
      review: '表示設定',
      file: '表示設定',
    }[d.domain]
  );
}
function insertionPosition(content: NativeContent) {
  const items =
    'nodes' in content
      ? [...content.nodes, ...(content.sections ?? [])]
      : 'elements' in content
        ? content.elements
        : [];
  return {
    x: items.length ? Math.max(...items.map((e) => e.bounds.x + e.bounds.width)) + 80 : 0,
    y: 0,
  };
}
