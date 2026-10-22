import { useMemo, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import {
  definitionRef,
  refKey,
  type ComponentContract,
  type LockedClosure,
} from '@editor-platform/reuse-core';
import {
  authorReusableComponent,
  retainedComponent,
  previewSharedTemplate,
  applySharedTemplate,
  type ComponentDefinition,
  type CatalogAdapter,
  TemplateCatalog,
  type Domain,
  type NativeContent,
  type PreparedApplication,
  type ReusableDraft,
  importTemplatePack,
  materializeComponent,
  reusablePrototype,
  type PrivateViewSettings,
} from '@editor-platform/templates';
import type { TemplateGalleryProps } from './gallery';
import { TemplateInputForm } from './form';
import { TemplatePreview } from './preview';
import { ComponentContractEditor } from './reuse-contract-editor';
import { ReusableRevisionDialog, draftDefinition } from './reuse-revision';
import { ComponentSlotsForm } from './reuse-slot-form';
import { ReusableViewLibrary, ReusableViewPresetEditor } from './reuse-view';
import { ComponentStyleBindings, type ComponentStyleSelection } from './reuse-style-bindings';
import { useComponentSelection, useReusableComponents, useSlotDraft } from './reuse-library-hooks';
import {
  componentFields,
  componentInputValues,
  downloadComponentPack,
  initialSlidePageId,
  libraryBasis,
  linkedInstances,
  prepareArtifactModeChange,
  prepareComponentChange,
  showsArtifactModes,
} from './reuse-library-model';
import { ArtifactModeFieldset, ComponentBrowser, LinkedInstanceList } from './reuse-library-browse';
import {
  ComponentInsertOptions,
  ComponentInstanceActions,
  ComponentVariantFields,
  PreparedComponentPreview,
} from './reuse-library-selected';
type SaveComponentProps = {
  domain: Domain;
  content: NativeContent;
  ids: string[];
  slideSelection?: { pageId: string; elementId: string }[];
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
        slideSelection: props.slideSelection,
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
  const [error, setError] = useState('');
  const selection = useComponentSelection();
  const { selected, closure, instance } = selection;
  const [artifactMode, setArtifactMode] = useState(
    'reuse' in target.content ? (target.content.reuse?.artifactMode ?? '') : '',
  );
  const [reuse, setReuse] = useState<'linked' | 'copy'>('linked'),
    [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<{ application: PreparedApplication; token?: string }>();
  const [search, setSearch] = useState('');
  const [slidePageId, setSlidePageId] = useState(() => initialSlidePageId(target));
  const [refresh, setRefresh] = useState(0);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [revision, setRevision] = useState<{
    definition: ComponentDefinition;
    closure: LockedClosure<unknown>;
    draft?: ReusableDraft;
  }>();
  const slot = useSlotDraft();
  const { items, drafts, archived } = useReusableComponents({
    catalog: props.catalog,
    writeCatalog: props.writeCatalog,
    domain: target.domain,
    refresh,
    includeArchived,
    setError,
  });
  const instances = linkedInstances(target.content);
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
  const clear = () => setPrepared(undefined);
  const select = (
    definition: ComponentDefinition,
    retained?: ReturnType<typeof retainedComponent>,
  ) => {
    void run(async () => {
      const closure = retained?.closure ?? (await props.catalog.closure(definitionRef(definition)));
      selection.choose(definition, closure, retained, () => {
        clear();
        setError('');
      });
    });
  };
  const basis = () => libraryBasis(target);
  const stage = async (application: PreparedApplication) => {
    const preview = target.shared
      ? await previewSharedTemplate(application, target.shared)
      : undefined;
    setPrepared({ application, token: preview?.token });
  };
  const stageWith = (prepare: () => Promise<PreparedApplication> | PreparedApplication) => {
    void run(async () => {
      await stage(await prepare());
    });
  };
  const values = componentInputValues({ ...selection, content: target.content });
  const disabled = busy || props.readOnly;
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
          selection.setSelected(undefined);
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
                {showsArtifactModes(target.content, instances) && (
                  <ArtifactModeFieldset
                    content={target.content}
                    instances={instances}
                    disabled={disabled}
                    value={artifactMode}
                    onChange={(value) => {
                      setArtifactMode(value);
                      clear();
                    }}
                    onPreview={() =>
                      void run(async () =>
                        stage(await prepareArtifactModeChange(basis(), artifactMode)),
                      )
                    }
                  />
                )}
                <LinkedInstanceList
                  content={target.content}
                  instances={instances}
                  onSelect={(retained) => select(retained.definition, retained)}
                />
              </>
            ) : (
              <ComponentBrowser
                items={items}
                archived={archived}
                drafts={drafts}
                search={search}
                includeArchived={includeArchived}
                busy={busy}
                readOnly={props.readOnly}
                writeCatalog={props.writeCatalog}
                onSearch={setSearch}
                onIncludeArchived={setIncludeArchived}
                onSelect={(d) => select(d)}
                onDraft={(draft) =>
                  setRevision({ definition: draftDefinition(draft), closure: draft.closure, draft })
                }
                onImport={(file) =>
                  void run(async () => {
                    await importTemplatePack(await file.text(), props.writeCatalog!);
                    setRefresh((value) => value + 1);
                  })
                }
              />
            )}
            {selected && (
              <>
                <h3>{selected.name}</h3>
                {!instance && (
                  <ComponentInsertOptions
                    selected={selected}
                    content={target.content}
                    dataTarget={selection.dataTarget}
                    slidePageId={slidePageId}
                    reuse={reuse}
                    busy={busy}
                    readOnly={props.readOnly}
                    canRevise={!!props.writeCatalog}
                    canArchive={!!props.writeCatalog?.archiveReusable}
                    archived={archived.includes(refKey(selected))}
                    onDataTarget={(value) => {
                      selection.setDataTarget(value);
                      clear();
                    }}
                    onSlidePage={(id) => {
                      setSlidePageId(id);
                      clear();
                    }}
                    onReuse={(value) => {
                      setReuse(value);
                      clear();
                    }}
                    onRevise={() => {
                      void run(async () => {
                        setRevision({
                          definition: selected,
                          closure: await props.catalog.closure(definitionRef(selected)),
                        });
                      });
                    }}
                    onExport={() => {
                      void run(() => downloadComponentPack(props.catalog, selected, closure));
                    }}
                    onArchive={() =>
                      void run(async () => {
                        await props.writeCatalog!.archiveReusable!(
                          selected.libraryId,
                          selected.definitionId,
                          !archived.includes(refKey(selected)),
                        );
                        selection.setSelected(undefined);
                        clear();
                        setRefresh((n) => n + 1);
                      })
                    }
                  />
                )}
                <ComponentVariantFields
                  selected={selected}
                  closure={closure}
                  variant={selection.variant}
                  mode={selection.mode}
                  onVariant={(value) => {
                    selection.changeVariant(value);
                    clear();
                  }}
                  onMode={(value) => {
                    selection.changeMode(value);
                    clear();
                  }}
                />
                <TemplateInputForm
                  fields={componentFields(selected.payload.contract)}
                  values={values}
                  assets={selected.payload.template.assets}
                  onChange={() => {}}
                  onFieldChange={(key, value) => {
                    selection.changeInput(selected, key, value);
                    clear();
                  }}
                />
                <button
                  disabled={disabled}
                  onClick={() =>
                    stageWith(() =>
                      prepareComponentChange({
                        base: basis(),
                        catalog: props.catalog,
                        target,
                        selected,
                        selection,
                        reuse,
                        slidePageId,
                      }),
                    )
                  }
                >
                  変更をプレビュー
                </button>
                {!instance && (
                  <ComponentSlotsForm
                    definition={selected}
                    values={selection.initialSlots}
                    items={items}
                    catalog={props.catalog}
                    onChange={(values) => {
                      selection.setInitialSlots(values);
                      clear();
                    }}
                  />
                )}
                {instance && (
                  <ComponentInstanceActions
                    instance={instance}
                    instances={instances}
                    selected={selected}
                    content={target.content}
                    domain={target.domain}
                    catalog={props.catalog}
                    items={items}
                    disabled={disabled}
                    slot={slot}
                    basis={basis}
                    onStage={stage}
                    onClear={clear}
                    onPrepare={stageWith}
                  />
                )}
              </>
            )}
          </div>
          <div className="tp-preview-column">
            <PreparedComponentPreview
              domain={target.domain}
              content={target.content}
              prepared={prepared}
              selected={selected}
              linked={!!instance}
              disabled={disabled}
              onApply={() => {
                void run(async () => {
                  if (props.readOnly) throw new Error('Read only');
                  if (target.shared)
                    await applySharedTemplate(
                      prepared!.application,
                      target.shared,
                      prepared!.token!,
                    );
                  await props.onApply(prepared!.application);
                  props.onClose();
                });
              }}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
