import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import { clone } from '@editor-platform/artifact-core';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import {
  TemplateCatalog,
  type StructureLayout,
  inputDefaults,
  importTemplatePack,
  exportTemplatePack,
  TemplateError,
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
import { useErrorReveal, useTemplateItems } from './gallery-hooks';
import {
  applyGalleryPrepared,
  download,
  fieldMappingColumns,
  galleryTitle,
  mappingContentFor,
  prepareGalleryPreview,
  remember,
  unitLabel,
  variedInputs,
  withStructureItemIds,
  type GalleryPrepared,
} from './gallery-model';
import {
  FieldMappingFieldset,
  GalleryPreviewColumn,
  SelectedTemplateHeading,
  StructureVariants,
  TemplateCards,
  TemplateFilters,
} from './gallery-parts';
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
export function TemplateGallery(props: TemplateGalleryProps) {
  const { catalog, local, kind, target, onClose } = props;
  const [domain, setDomain] = useState<Domain | ''>(target?.domain ?? props.initialDomain ?? '');
  const [query, setQuery] = useState(''),
    [unit, setUnit] = useState(''),
    [category, setCategory] = useState(''),
    [recentOnly, setRecent] = useState(false);
  const [selected, setSelected] = useState<TemplateDefinition>(),
    [values, setValues] = useState<Record<string, InputValue>>({}),
    [prepared, setPrepared] = useState<GalleryPrepared>(),
    [error, setError] = useState(''),
    [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]),
    [busy, setBusy] = useState(false),
    [sampleRows, setSampleRows] = useState(true),
    [scope, setScope] = useState<'selection' | 'artifact'>('selection'),
    [mapping, setMapping] = useState<TemplateTarget['fieldMapping']>({});
  const working = useRef(false),
    drafts = useRef(new Map<string, Record<string, InputValue>>());
  const errorNotice = useErrorReveal(error);
  const { items, reload } = useTemplateItems({ catalog, kind, domain, query, category, setError });
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
  const update = (input: Record<string, InputValue>) => {
    const next = withStructureItemIds(selected, input);
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
      setPrepared(
        await prepareGalleryPreview({
          selected,
          input,
          kind,
          readOnly: props.readOnly,
          target,
          sampleRows,
          scope,
          mapping,
        }),
      );
    });
  useEffect(() => {
    if (selected && selected.domain !== 'data') void preview();
  }, [selected]);
  const vary = (count: number, layout?: StructureLayout) => {
    if (!selected?.structure) return;
    const next = variedInputs(
      { ...selected, structure: selected.structure },
      values,
      count,
      layout,
    );
    update(next);
    if (selected.domain !== 'data') void preview(next);
  };
  const mappingContent = mappingContentFor(selected, values);
  const apply = () =>
    run(async () => {
      if (!prepared || !selected) return;
      await applyGalleryPrepared(prepared, selected, props);
      remember(selected.templateId);
      onClose();
    });
  const clearPrepared = () => setPrepared(undefined);
  const mappingColumns = selected && fieldMappingColumns(kind, selected, target, mappingContent);
  return (
    <Dialog title={galleryTitle(kind)} onClose={onClose}>
      <div className="tp-gallery">
        {error && (
          <p className="tp-error" role="alert" ref={errorNotice} tabIndex={-1}>
            {error}
          </p>
        )}
        {!selected ? (
          <>
            <TemplateFilters
              kind={kind}
              items={items}
              query={query}
              domain={domain}
              domainLocked={!!target}
              category={category}
              unit={unit}
              recentOnly={recentOnly}
              onQuery={setQuery}
              onDomain={setDomain}
              onCategory={setCategory}
              onUnit={setUnit}
              onRecent={setRecent}
            />
            <TemplateCards items={items} recentOnly={recentOnly} unit={unit} onSelect={select} />
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
            <SelectedTemplateHeading
              selected={selected}
              kind={kind}
              items={items}
              busy={busy}
              onBack={() => {
                setSelected(undefined);
                setPrepared(undefined);
              }}
              onVersion={(version) =>
                void run(async () => select(await catalog.getVersion(selected.templateId, version)))
              }
              onExport={() =>
                void run(async () =>
                  download(
                    `${selected.templateId}-v${selected.templateVersion}.template.json`,
                    await exportTemplatePack([selected]),
                  ),
                )
              }
            />
            {selected.structure && (
              <StructureVariants
                selected={{ ...selected, structure: selected.structure }}
                values={values}
                busy={busy}
                onVary={vary}
              />
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
                        clearPrepared();
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
                        clearPrepared();
                      }}
                    >
                      <option value="selection">選択した要素のみ</option>
                      <option value="artifact">成果物全体</option>
                    </select>
                  </label>
                )}
                {mappingColumns && (
                  <FieldMappingFieldset
                    {...mappingColumns}
                    mapping={mapping}
                    onMapping={(next) => {
                      setMapping(next);
                      clearPrepared();
                    }}
                  />
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
              <GalleryPreviewColumn
                selected={selected}
                kind={kind}
                prepared={prepared}
                values={values}
                busy={busy}
                onApply={() => void apply()}
              />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
export { unitLabel };
