import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { clone } from '@editor-platform/artifact-core';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { DataComponentBindings } from './reuse-data';
import { isDeck } from '@editor-platform/slide/model';
import {
  definitionRef,
  refKey,
  resolveComponentProperties,
  type ComponentContract,
  type JsonValue,
  type LockedClosure,
  type ReuseInstance,
} from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  validateComponentDefinition,
  prepareComponentInsertion,
  prepareComponentProperties,
  prepareComponentSettings,
  componentTokenModes,
  previewArtifactMode,
  prepareComponentDetach,
  retainedComponent,
  localTemplateSnapshot,
  previewSharedTemplate,
  applySharedTemplate,
  type ComponentDefinition,
  type CatalogAdapter,
  TemplateCatalog,
  type Domain,
  type NativeContent,
  type TemplateTarget,
  type PreparedApplication,
  type InputField,
  type InputValue,
  reusableParts,
  reusablePartRich,
  prepareComponentSlot,
  type ReusableDraft,
  exportTemplatePack,
  importTemplatePack,
  type ComponentSlotValue,
  materializeComponent,
  reusablePrototype,
  type PrivateViewSettings,
} from '@editor-platform/templates';
import type { TemplateGalleryProps } from './gallery';
import { TemplateInputForm } from './form';
import { TemplatePreview } from './preview';
import { ComponentContractEditor } from './reuse-contract-editor';
import { ReusableRevisionDialog, draftDefinition } from './reuse-revision';
import { ComponentUpdatePanel } from './reuse-update';
import { ComponentSlotsForm } from './reuse-slot-form';
import { ReusableViewLibrary, ReusableViewPresetEditor } from './reuse-view';
import { ComponentStyleBindings, type ComponentStyleSelection } from './reuse-style-bindings';
const localIdentity = { actorId: 'local', clientId: 'local', sessionId: 'local' };
function fields(contract: ComponentContract): InputField[] {
  return contract.properties.map((p) => ({
    key: p.id,
    label: p.label,
    description: '',
    type: p.type,
    required: p.required,
    default: p.default,
    min: p.min,
    max: p.max,
    maxLength: p.maxLength,
    options: p.options,
  }));
}
type SaveComponentProps = {
  domain: Domain;
  content: NativeContent;
  ids: string[];
  catalog: CatalogAdapter;
  privateSettings?: PrivateViewSettings;
  onClose(): void;
  onSaved?(): void;
};
export function SaveComponentDialog(props: SaveComponentProps) {
  return props.domain === 'review' || props.domain === 'file' ? (
    <ReusableViewPresetEditor {...props} domain={props.domain} />
  ) : (
    <SaveNativeComponentDialog {...props} />
  );
}
function SaveNativeComponentDialog(props: SaveComponentProps) {
  const library = useMemo(() => new TemplateCatalog([props.catalog]), [props.catalog]);
  const [styles, setStyles] = useState<ComponentStyleSelection>({ styles: [], dependencies: [] });
  const [name, setName] = useState('マイ部品'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof authorReusableComponent>>>();
  const [contract, setContract] = useState<ComponentContract>();
  const [prototype, setPrototype] = useState<NativeContent>();
  const [previewContent, setPreviewContent] = useState<NativeContent>();
  const [selectedProperty, setSelectedProperty] = useState('');
  const [slide, setSlide] = useState<'objects' | 'pages'>('objects');
  const [data, setData] = useState<'fields' | 'view'>('fields');
  const prepare = async () => {
    setBusy(true);
    setError('');
    try {
      const value = await authorReusableComponent({
        domain: props.domain,
        content: props.content,
        ids: props.ids,
        name,
        ...(props.domain === 'slide' ? { slide } : {}),
        ...(props.domain === 'data' ? { data } : {}),
        ...(contract ? { contract } : {}),
        ...styles,
      });
      setDraft(value);
      setContract(value.definition.payload.contract);
      setPrototype(reusablePrototype(value.definition));
      setPreviewContent((await materializeComponent(value.definition, value.closure)).content);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const change = (value: ComponentContract) => {
    setContract(value);
    setDraft(undefined);
  };
  return (
    <Dialog title="再利用部品として保存" onClose={props.onClose}>
      <div className="tp-author">
        <p>選択範囲を部品として保存します。未選択の場合は現在の内容全体を使います。</p>
        {error && <p role="alert">{error}</p>}
        <label>
          部品名
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDraft(undefined);
            }}
          />
        </label>
        {props.domain === 'data' && (
          <label>
            Dataの再利用範囲
            <select
              value={data}
              onChange={(e) => {
                setData(e.target.value as 'fields' | 'view');
                setContract(undefined);
                setDraft(undefined);
                setPrototype(undefined);
              }}
            >
              <option value="fields">型付き項目セット</option>
              <option value="view">ビュー・フォーム・グラフ・集計の設定</option>
            </select>
          </label>
        )}
        {props.domain === 'slide' && (
          <label>
            Slideの再利用範囲
            <select
              value={slide}
              onChange={(e) => {
                setSlide(e.target.value as 'objects' | 'pages');
                setContract(undefined);
                setDraft(undefined);
                setPrototype(undefined);
              }}
            >
              <option value="objects">1ページ内の部品・ヘッダー・フッター</option>
              <option value="pages">ページ全体のレイアウト</option>
            </select>
          </label>
        )}
        <button
          disabled={busy}
          onClick={() => {
            void prepare();
          }}
        >
          部品をプレビュー
        </button>
        {contract && (
          <>
            {prototype && (
              <>
                <ComponentStyleBindings
                  domain={props.domain}
                  contract={contract}
                  content={prototype}
                  catalog={library}
                  value={styles}
                  onChange={(value) => {
                    setStyles(value);
                    setDraft(undefined);
                  }}
                  onWorking={setBusy}
                />
                <ComponentContractEditor
                  contract={contract}
                  content={prototype}
                  onChange={change}
                />
              </>
            )}
            <label>
              表示を切り替える部品
              <select
                value={selectedProperty}
                onChange={(e) => setSelectedProperty(e.target.value)}
              >
                <option value="">選択</option>
                {contract.properties
                  .filter((p) => p.type === 'boolean')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={!selectedProperty}
              onClick={() =>
                change({
                  ...contract,
                  variants: [
                    ...contract.variants.filter((v) => v.id !== 'compact'),
                    { id: 'compact', label: '簡略', values: { [selectedProperty]: false } },
                  ],
                })
              }
            >
              簡略表示を追加
            </button>
            <p>本文スロット: {contract.slots.map((s) => s.label).join('、') || 'なし'}</p>
            <details>
              <summary>入力・variant・slotの詳細設定</summary>
              <label>
                部品契約
                <textarea
                  aria-label="部品契約"
                  rows={10}
                  defaultValue={JSON.stringify(contract, null, 2)}
                  key={JSON.stringify(contract)}
                  onBlur={(e) => {
                    try {
                      change(JSON.parse(e.target.value) as ComponentContract);
                      setError('');
                    } catch {
                      setError('部品契約のJSONを確認してください。');
                    }
                  }}
                />
              </label>
            </details>
          </>
        )}
        {draft && (
          <>
            {draft.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
            <TemplatePreview domain={props.domain} content={previewContent} />
            <button
              disabled={busy || !props.catalog.saveReusableDraft}
              onClick={() => {
                setBusy(true);
                setError('');
                void props.catalog.saveReusableDraft!(
                  {
                    id: 'draft_' + crypto.randomUUID(),
                    revision: 1,
                    ref: definitionRef(draft.definition),
                    closure: draft.closure,
                  },
                  null,
                )
                  .then(() => {
                    props.onSaved?.();
                    props.onClose();
                  })
                  .catch((e) => setError((e as Error).message))
                  .finally(() => setBusy(false));
              }}
            >
              下書きとして保存
            </button>
            <button
              disabled={busy || !props.catalog.putBundle}
              onClick={() => {
                setBusy(true);
                setError('');
                void props.catalog.putBundle!({ templates: [], reusable: [draft.closure] })
                  .then(() => {
                    props.onSaved?.();
                    props.onClose();
                  })
                  .catch((e) => setError((e as Error).message))
                  .finally(() => setBusy(false));
              }}
            >
              部品を公開
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
export interface ReusableLibraryProps {
  catalog: TemplateCatalog;
  writeCatalog?: CatalogAdapter;
  target: NonNullable<TemplateGalleryProps['target']>;
  readOnly: boolean;
  inspect?: boolean;
  privateSettings?: PrivateViewSettings;
  onPrivateSettings?(settings: PrivateViewSettings, expected?: string): void | Promise<void>;
  onClose(): void;
  onApply(prepared: PreparedApplication): void | Promise<void>;
}
export function ReusableLibrary(props: ReusableLibraryProps) {
  return props.target.domain === 'review' || props.target.domain === 'file' ? (
    <ReusableViewLibrary {...props} />
  ) : (
    <NativeReusableLibrary {...props} />
  );
}
function NativeReusableLibrary(props: ReusableLibraryProps) {
  const { target } = props;
  const [items, setItems] = useState<ComponentDefinition[]>([]),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<ComponentDefinition>(),
    [closure, setClosure] = useState<LockedClosure<unknown>>();
  const [instance, setInstance] = useState<ReuseInstance>();
  const [inputs, setInputs] = useState<Record<string, JsonValue>>({}),
    [variant, setVariant] = useState('');
  const [changed, setChanged] = useState<string[]>([]);
  const [mode, setMode] = useState('');
  const [modeChanged, setModeChanged] = useState(false),
    [variantChanged, setVariantChanged] = useState(false);
  const [artifactMode, setArtifactMode] = useState(
    'reuse' in target.content ? (target.content.reuse?.artifactMode ?? '') : '',
  );
  const [initialSlots, setInitialSlots] = useState<Record<string, ComponentSlotValue[]>>({});
  const [reuse, setReuse] = useState<'linked' | 'copy'>('linked'),
    [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<{ application: PreparedApplication; token?: string }>();
  const [search, setSearch] = useState('');
  const [dataTarget, setDataTarget] = useState<TemplateTarget>({});
  const [slidePageId, setSlidePageId] = useState(() =>
    isDeck(target.content)
      ? (target.content.slides.find(
          (p) => target.ids?.includes(p.id) || p.objects.some((o) => target.ids?.includes(o.id)),
        )?.id ??
        target.content.slides[0]?.id ??
        '')
      : '',
  );
  const [refresh, setRefresh] = useState(0),
    [drafts, setDrafts] = useState<ReusableDraft[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false),
    [archived, setArchived] = useState<string[]>([]);
  const [revision, setRevision] = useState<{
    definition: ComponentDefinition;
    closure: LockedClosure<unknown>;
    draft?: ReusableDraft;
  }>();
  const [slotId, setSlotId] = useState(''),
    [slotText, setSlotText] = useState(''),
    [slotComponent, setSlotComponent] = useState('');
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      props.catalog.listReusable({
        domain: target.domain,
        kind: 'component',
        archived: includeArchived,
      }),
      props.catalog.listReusable({ domain: target.domain, kind: 'component' }),
    ])
      .then(async ([values, active]) => {
        const checked = await Promise.all(values.map(validateComponentDefinition));
        if (!cancelled) {
          setItems(checked);
          setArchived(
            values.filter((d) => !active.some((a) => refKey(a) === refKey(d))).map(refKey),
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.catalog, target.domain, refresh, includeArchived]);
  useEffect(() => {
    let cancelled = false;
    void props.writeCatalog
      ?.listReusableDrafts?.()
      .then((values) => {
        if (!cancelled)
          setDrafts(
            values.filter((d) => d.ref.domain === target.domain && d.ref.kind === 'component'),
          );
      })
      .catch((error) => {
        if (!cancelled) setError((error as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.writeCatalog, target.domain, refresh]);
  const instances =
    'reuse' in target.content
      ? (target.content.reuse?.instances.filter(
          (i) => i.ref.libraryId !== 'native-template-layouts',
        ) ?? [])
      : [];
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const select = (
    definition: ComponentDefinition,
    retained?: ReturnType<typeof retainedComponent>,
  ) => {
    void run(async () => {
      const closure = retained?.closure ?? (await props.catalog.closure(definitionRef(definition)));
      setSelected(definition);
      setInstance(retained?.instance);
      setClosure(closure);
      setInputs(clone(retained?.instance.inputs ?? {}));
      setVariant(retained?.instance.variant ?? '');
      setMode(retained?.instance.mode ?? '');
      setModeChanged(false);
      setVariantChanged(false);
      setPrepared(undefined);
      setError('');
      setChanged([]);
      setInitialSlots({});
      setDataTarget({});
    });
  };
  const basis = () => {
    if (target.shared?.pendingCount) throw new Error('入力の同期完了後にプレビューしてください。');
    return {
      state:
        target.shared?.confirmed ??
        localTemplateSnapshot(target.artifactId, target.domain, target.content),
      identity: target.shared?.adapter.identity ?? localIdentity,
    };
  };
  const stage = async (application: PreparedApplication) => {
    const preview = target.shared
      ? await previewSharedTemplate(application, target.shared)
      : undefined;
    setPrepared({ application, token: preview?.token });
  };
  let values: Record<string, InputValue> = inputs;
  if (selected)
    try {
      values = resolveComponentProperties(
        selected.payload.contract,
        inputs,
        variant || undefined,
      ).values;
    } catch {
      /* preview reports schema diagnostics */
    }
  if (instance && selected) {
    values = { ...values };
    const native = reusableParts(target.content);
    for (const property of selected.payload.contract.properties) {
      if (changed.includes(property.id) || !['text', 'rich-text'].includes(property.type)) continue;
      const target = property.targets[0],
        part = native.get(instance.parts[target.partId]);
      if (!part) continue;
      if (target.field === 'text') values[property.id] = String(part.text ?? '');
      if (target.field === 'rich') values[property.id] = reusablePartRich(part);
    }
  }
  if (revision && props.writeCatalog)
    return (
      <ReusableRevisionDialog
        {...revision}
        catalog={props.writeCatalog}
        onClose={() => {
          setRevision(undefined);
          setRefresh((value) => value + 1);
        }}
        onSaved={() => {
          setRevision(undefined);
          setRefresh((value) => value + 1);
          setSelected(undefined);
        }}
      />
    );
  return (
    <Dialog title={props.inspect ? '部品の入力・表示' : '部品ライブラリ'} onClose={props.onClose}>
      <div className="tp-gallery">
        {error && <p role="alert">{error}</p>}
        <div className="tp-workspace">
          <div className="tp-form-column">
            {props.inspect ? (
              <>
                {(('reuse' in target.content && !!target.content.reuse?.artifactMode) ||
                  instances.some(
                    (i) =>
                      retainedComponent(target.content, i.id).definition.payload.styles?.length,
                  )) && (
                  <fieldset disabled={busy || props.readOnly}>
                    <legend>成果物のトークンモード</legend>
                    <label>
                      成果物で継承するモード
                      <select
                        value={artifactMode}
                        onChange={(e) => {
                          setArtifactMode(e.target.value);
                          setPrepared(undefined);
                        }}
                      >
                        <option value="">各トークンの既定値</option>
                        {[
                          ...new Set([
                            ...('reuse' in target.content && target.content.reuse?.artifactMode
                              ? [target.content.reuse.artifactMode]
                              : []),
                            ...instances.flatMap((i) => {
                              const retained = retainedComponent(target.content, i.id);
                              return componentTokenModes(retained.definition, retained.closure);
                            }),
                          ]),
                        ].map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={() =>
                        void run(async () => {
                          const diff = await previewArtifactMode({
                            ...basis(),
                            mode: artifactMode || null,
                          });
                          if (!diff.prepared)
                            throw new Error(diff.conflicts.map((c) => c.message).join('\n'));
                          await stage(diff.prepared);
                        })
                      }
                    >
                      成果物のモードをプレビュー
                    </button>
                  </fieldset>
                )}
                <h3>この成果物のリンク部品</h3>
                {instances.length === 0 && <p>リンク部品はありません。</p>}
                {instances.map((i) => (
                  <button
                    key={i.id}
                    onClick={() => {
                      const retained = retainedComponent(target.content, i.id);
                      select(retained.definition, retained);
                    }}
                  >
                    {retainedComponent(target.content, i.id).definition.name} v{i.ref.version}
                  </button>
                ))}
              </>
            ) : (
              <>
                <label>
                  部品を検索
                  <input value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeArchived}
                    onChange={(e) => setIncludeArchived(e.target.checked)}
                  />
                  アーカイブ済みも表示
                </label>
                {items
                  .filter((d) => d.name.includes(search))
                  .map((d) => (
                    <button key={refKey(d)} onClick={() => select(d)}>
                      {d.name} v{d.version}
                      {archived.includes(refKey(d)) ? '（アーカイブ済み）' : ''}
                    </button>
                  ))}
                {items.length === 0 && <p>「再利用部品として保存」から部品を作成できます。</p>}
                {drafts.length > 0 && <h3>保存した下書き</h3>}
                {drafts.map((draft) => (
                  <button
                    key={draft.id}
                    disabled={props.readOnly}
                    onClick={() =>
                      setRevision({
                        definition: draftDefinition(draft),
                        closure: draft.closure,
                        draft,
                      })
                    }
                  >
                    {draftDefinition(draft).name} — 下書き {draft.revision}
                  </button>
                ))}
                {props.writeCatalog && (
                  <label>
                    部品packを読み込む
                    <input
                      type="file"
                      accept="application/json,.json"
                      disabled={busy || props.readOnly}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void run(async () => {
                          await importTemplatePack(await file.text(), props.writeCatalog!);
                          setRefresh((value) => value + 1);
                        });
                      }}
                    />
                  </label>
                )}
              </>
            )}
            {selected && (
              <>
                <h3>{selected.name}</h3>
                {!instance && isStructuredData(target.content) && (
                  <DataComponentBindings
                    definition={selected}
                    target={target.content}
                    value={dataTarget}
                    onChange={(value) => {
                      setDataTarget(value);
                      setPrepared(undefined);
                    }}
                  />
                )}
                {!instance && isDeck(target.content) && selected.payload.slide === 'objects' && (
                  <label>
                    挿入先ページ
                    <select
                      value={slidePageId}
                      onChange={(e) => {
                        setSlidePageId(e.target.value);
                        setPrepared(undefined);
                      }}
                    >
                      <option value="">ページを選択</option>
                      {target.content.slides.map((p, i) => (
                        <option key={p.id} value={p.id}>
                          {i + 1}. {p.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {!instance && selected.domain === 'slide' && (
                  <p>
                    {selected.payload.slide === 'objects'
                      ? '選択したページ内に挿入し、ページ順・本文・ノートを保持します。'
                      : 'ページ全体を追加します。寸法の異なるデッキには挿入できません。'}
                  </p>
                )}
                {!instance && props.writeCatalog && (
                  <button
                    disabled={busy || props.readOnly}
                    onClick={() => {
                      void run(async () => {
                        setRevision({
                          definition: selected,
                          closure: await props.catalog.closure(definitionRef(selected)),
                        });
                      });
                    }}
                  >
                    新版の下書きを作成
                  </button>
                )}
                {!instance && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        const text = await exportTemplatePack(
                          [],
                          [closure ?? (await props.catalog.closure(definitionRef(selected)))],
                        );
                        const url = URL.createObjectURL(
                          new Blob([text], { type: 'application/json' }),
                        );
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = 'reusable-components.json';
                        link.click();
                        URL.revokeObjectURL(url);
                      });
                    }}
                  >
                    部品packを書き出す
                  </button>
                )}
                {!instance && (
                  <label>
                    挿入方法
                    <select
                      value={reuse}
                      onChange={(e) => {
                        setReuse(e.target.value as 'linked' | 'copy');
                        setPrepared(undefined);
                      }}
                    >
                      <option value="linked">版を保持してリンク</option>
                      <option value="copy">独立したコピー</option>
                    </select>
                  </label>
                )}
                {!instance && props.writeCatalog?.archiveReusable && (
                  <button
                    disabled={busy || props.readOnly}
                    onClick={() =>
                      void run(async () => {
                        await props.writeCatalog!.archiveReusable!(
                          selected.libraryId,
                          selected.definitionId,
                          !archived.includes(refKey(selected)),
                        );
                        setSelected(undefined);
                        setPrepared(undefined);
                        setRefresh((n) => n + 1);
                      })
                    }
                  >
                    {archived.includes(refKey(selected))
                      ? 'アーカイブから戻す'
                      : '部品をアーカイブ'}
                  </button>
                )}
                <label>
                  表示バリエーション
                  <select
                    value={variant}
                    onChange={(e) => {
                      setVariant(e.target.value);
                      setVariantChanged(true);
                      setPrepared(undefined);
                    }}
                  >
                    <option value="">
                      既定
                      {selected.payload.contract.defaultVariant
                        ? `（${selected.payload.contract.variants.find((v) => v.id === selected.payload.contract.defaultVariant)?.label ?? selected.payload.contract.defaultVariant}）`
                        : ''}
                    </option>
                    {selected.payload.contract.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
                {closure && componentTokenModes(selected, closure).length > 0 && (
                  <label>
                    部品のトークンモード
                    <select
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value);
                        setModeChanged(true);
                        setPrepared(undefined);
                      }}
                    >
                      <option value="">成果物の設定／トークン既定値を継承</option>
                      {componentTokenModes(selected, closure).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <TemplateInputForm
                  fields={fields(selected.payload.contract)}
                  values={values}
                  assets={selected.payload.template.assets}
                  onChange={() => {}}
                  onFieldChange={(key, value) => {
                    const field = selected.payload.contract.properties.find((p) => p.id === key);
                    setInputs((old) => ({
                      ...old,
                      [key]: field?.type === 'asset' && value === '' ? null : value,
                    }));
                    setChanged((old) => [...new Set([...old, key])]);
                    setPrepared(undefined);
                  }}
                />
                <button
                  disabled={busy || props.readOnly}
                  onClick={() => {
                    void run(async () => {
                      const base = basis();
                      if (instance)
                        await stage(
                          await prepareComponentSettings({
                            ...base,
                            instanceId: instance.id,
                            inputs: Object.fromEntries(changed.map((key) => [key, inputs[key]])),
                            ...(variantChanged ? { variant: variant || null } : {}),
                            ...(modeChanged ? { mode: mode || null } : {}),
                          }),
                        );
                      else
                        await stage(
                          await prepareComponentInsertion({
                            ...base,
                            definition: selected,
                            closure:
                              closure ?? (await props.catalog.closure(definitionRef(selected))),
                            inputs,
                            slots: initialSlots,
                            variant: variantChanged ? variant || undefined : undefined,
                            mode: mode || undefined,
                            reuse,
                            target: {
                              ...dataTarget,
                              afterId: target.afterId,
                              position: { x: 40, y: 40 },
                              ...(selected.payload.slide === 'objects' ? { slidePageId } : {}),
                            },
                          }),
                        );
                    });
                  }}
                >
                  変更をプレビュー
                </button>
                {!instance && (
                  <ComponentSlotsForm
                    definition={selected}
                    values={initialSlots}
                    items={items}
                    catalog={props.catalog}
                    onChange={(values) => {
                      setInitialSlots(values);
                      setPrepared(undefined);
                    }}
                  />
                )}
                {instance && (
                  <>
                    {instances.some((value) => value.id === instance.id) && (
                      <ComponentUpdatePanel
                        key={instance.id}
                        instanceId={instance.id}
                        content={target.content}
                        catalog={props.catalog}
                        items={items}
                        basis={basis}
                        disabled={busy || props.readOnly}
                        onStage={stage}
                        onClear={() => setPrepared(undefined)}
                      />
                    )}
                    {selected.payload.contract.slots.length > 0 && (
                      <fieldset>
                        <legend>本文・子部品スロット</legend>
                        <label>
                          追加先スロット
                          <select
                            value={slotId}
                            onChange={(e) => {
                              setSlotId(e.target.value);
                              setPrepared(undefined);
                            }}
                          >
                            <option value="">選択</option>
                            {selected.payload.contract.slots.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}（最大{s.max}件）
                              </option>
                            ))}
                          </select>
                        </label>
                        {target.domain === 'document' && (
                          <label>
                            追加する本文
                            <textarea
                              value={slotText}
                              onChange={(e) => {
                                setSlotText(e.target.value);
                                setPrepared(undefined);
                              }}
                            />
                          </label>
                        )}
                        <label>
                          追加する子部品
                          <select
                            value={slotComponent}
                            onChange={(e) => {
                              setSlotComponent(e.target.value);
                              setPrepared(undefined);
                            }}
                          >
                            <option value="">本文を追加 / 未選択</option>
                            {items.map((d) => (
                              <option key={d.definitionId} value={d.definitionId}>
                                {d.name} v{d.version}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          disabled={
                            !slotId || busy || props.readOnly || (!slotComponent && !slotText)
                          }
                          onClick={() => {
                            void run(async () => {
                              const child = items.find((d) => d.definitionId === slotComponent);
                              await stage(
                                await prepareComponentSlot({
                                  ...basis(),
                                  instanceId: instance.id,
                                  slotId,
                                  values: [
                                    child
                                      ? {
                                          kind: 'component',
                                          definition: child,
                                          closure: await props.catalog.closure(
                                            definitionRef(child),
                                          ),
                                        }
                                      : {
                                          kind: 'body',
                                          content: {
                                            schemaVersion: 2,
                                            blocks: [
                                              { id: 'body', type: 'paragraph', text: slotText },
                                            ],
                                          },
                                        },
                                  ],
                                }),
                              );
                            });
                          }}
                        >
                          スロットへの追加をプレビュー
                        </button>
                      </fieldset>
                    )}
                    <button
                      disabled={busy || props.readOnly}
                      onClick={() => {
                        void run(async () => {
                          await stage(
                            await prepareComponentProperties({
                              ...basis(),
                              instanceId: instance.id,
                              reset: selected.payload.contract.properties.map((p) => p.id),
                            }),
                          );
                        });
                      }}
                    >
                      入力を既定値に戻す
                    </button>
                    <button
                      disabled={busy || props.readOnly}
                      onClick={() => {
                        void run(async () => {
                          const base = basis();
                          await stage(
                            prepareComponentDetach(base.state, base.identity, instance.id),
                          );
                        });
                      }}
                    >
                      リンク解除をプレビュー
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          <div className="tp-preview-column">
            {prepared ? (
              <>
                <TemplatePreview domain={target.domain} content={prepared.application.preview} />
                {prepared.application.notices.map((n) => (
                  <p key={n}>{n}</p>
                ))}
                <button
                  className="primary"
                  disabled={busy || props.readOnly}
                  onClick={() => {
                    void run(async () => {
                      if (props.readOnly) throw new Error('Read only');
                      if (target.shared)
                        await applySharedTemplate(
                          prepared.application,
                          target.shared,
                          prepared.token!,
                        );
                      await props.onApply(prepared.application);
                      props.onClose();
                    });
                  }}
                >
                  プレビューした変更を適用
                </button>
              </>
            ) : (
              selected && (
                <TemplatePreview
                  domain={target.domain}
                  content={instance ? target.content : reusablePrototype(selected)}
                />
              )
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
