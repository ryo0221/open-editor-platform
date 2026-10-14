import { useMemo, useState } from 'react';
import { clone } from '@editor-platform/artifact-core';
import { Dialog } from '@editor-platform/editor-ui';
import {
  definitionRef,
  refKey,
  sealReusableDefinition,
  type LockedClosure,
} from '@editor-platform/reuse-core';
import {
  closureDefinition,
  patchReusablePart,
  publicPropertySuggestions,
  defaultComponentContract,
  reusableParts,
  nativePropertyPatch,
  sealDefinition,
  validateReusableClosure,
  materializeComponent,
  reusablePrototype,
  lockReusableRoot,
  TemplateCatalog,
  type CatalogAdapter,
  type ComponentDefinition,
  type ReusableDraft,
  type NativeContent,
  type Domain,
} from '@editor-platform/templates';
import { ComponentContractEditor } from './reuse-contract-editor';
import { TemplateInputForm } from './form';
import { TemplatePreview } from './preview';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { DataSurface, isStructuredData } from '@editor-platform/structured-data';
import { WhiteboardPortsEditor } from '@editor-platform/whiteboard';
import { ComponentStyleBindings, type ComponentStyleSelection } from './reuse-style-bindings';

export function ReusableRevisionDialog(props: {
  definition: ComponentDefinition;
  closure: LockedClosure<unknown>;
  draft?: ReusableDraft;
  catalog: CatalogAdapter;
  onClose(): void;
  onSaved(): void;
}) {
  const library = useMemo(() => new TemplateCatalog([props.catalog]), [props.catalog]);
  const [styles, setStyles] = useState<ComponentStyleSelection>({
    styles: props.definition.payload.styles ?? [],
    dependencies: props.closure.definitions,
  });
  const [name, setName] = useState(props.definition.name),
    [contract, setContract] = useState(clone(props.definition.payload.contract));
  const [content, setContent] = useState(reusablePrototype(props.definition));
  const [partId, setPartId] = useState(contract.parts[0]?.id ?? ''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(props.draft),
    [dirty, setDirty] = useState(!props.draft);
  const [preview, setPreview] = useState<NativeContent>();
  const id = useState(props.draft?.id ?? 'draft_' + crypto.randomUUID())[0];
  const native = reusableParts(content),
    part = contract.parts.find((p) => p.id === partId) ?? contract.parts[0];
  const appearance = (part ? publicPropertySuggestions(content, part) : []).filter(
    (p) => !['text', 'rich', 'visible', 'src'].includes(p.targets[0].field),
  );
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const invalidate = () => {
    setDirty(true);
    setPreview(undefined);
  };
  const candidate = async () => {
    const template = await sealDefinition({ ...props.definition.payload.template, name, content });
    const definition = await sealReusableDefinition({
      ...props.definition,
      name,
      version: props.draft ? props.definition.version : props.definition.version + 1,
      dependencies: [
        ...new Map(
          [
            ...props.definition.dependencies.filter((ref) => ref.kind !== 'style'),
            ...styles.styles.map((b) => b.ref),
          ].map((ref) => [refKey(ref), ref]),
        ).values(),
      ],
      payload: { ...props.definition.payload, template, contract, styles: styles.styles },
    });
    const closure = await lockReusableRoot(definition, styles.dependencies);
    await validateReusableClosure(closure);
    return {
      definition,
      closure,
      preview: (await materializeComponent(definition, closure)).content,
    };
  };
  return (
    <Dialog title="部品の下書き・新版公開" onClose={props.onClose}>
      <div className="tp-author">
        <p>
          公開済みの版と、利用中の成果物は変更されません。公開後、利用先で改訂を選んで適用します。
        </p>
        {error && <p role="alert">{error}</p>}
        <label>
          部品名
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              invalidate();
            }}
          />
        </label>
        {isStructuredData(content) && (
          <section aria-label="Data部品の項目とビュー">
            <p>既存のData設定で項目・ビューを編集します。公開時にレコードは含められません。</p>
            <div className="tp-data-preview">
              <DataSurface
                content={content}
                select={() => {}}
                layout={{
                  viewKey: 'reuse-data-draft',
                  defaultPanels: { left: false, right: true },
                }}
                execute={(cmd) => {
                  try {
                    const next = cmd.apply(content);
                    if (next.rows.length)
                      throw new Error(
                        '部品にはレコードを保存しません。項目・ビュー設定を編集してください。',
                      );
                    const parts = defaultComponentContract(next)
                      .parts.map(
                        (p) =>
                          contract.parts.find((previous) => previous.nativeId === p.nativeId) ?? p,
                      )
                      .filter(
                        (p) =>
                          props.definition.payload.data !== 'view' ||
                          next.views?.some((v) => v.id === p.nativeId),
                      );
                    setContent(next);
                    setContract({
                      ...contract,
                      parts,
                      properties: contract.properties.filter((p) =>
                        p.targets.every((t) => parts.some((part) => part.id === t.partId)),
                      ),
                      slots: [],
                    });
                    invalidate();
                    setError('');
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              />
            </div>
          </section>
        )}
        {part && (
          <fieldset>
            <legend>部品の外観</legend>
            <label>
              外観の対象
              <select value={partId} onChange={(e) => setPartId(e.target.value)}>
                {contract.parts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {String(
                      native.get(p.nativeId)?.name ?? native.get(p.nativeId)?.text ?? p.nativeId,
                    ).slice(0, 50)}
                  </option>
                ))}
              </select>
            </label>
            {isWhiteboard(content) && content.nodes.some((n) => n.id === part.nativeId) && (
              <WhiteboardPortsEditor
                ports={content.nodes.find((n) => n.id === part.nativeId)!.ports}
                used={content.connectors.flatMap((c) =>
                  [
                    c.from === part.nativeId ? c.fromPort : undefined,
                    c.to === part.nativeId ? c.toPort : undefined,
                  ].filter((p): p is string => !!p),
                )}
                onChange={(ports) => {
                  const next = clone(content);
                  next.nodes.find((n) => n.id === part.nativeId)!.ports = ports;
                  setContent(next);
                  invalidate();
                }}
              />
            )}
            <TemplateInputForm
              fields={appearance.map((p) => ({ ...p, key: p.targets[0].field, description: '' }))}
              values={Object.fromEntries(
                appearance.map((p) => [p.targets[0].field, p.default ?? null]),
              )}
              onChange={() => {}}
              onFieldChange={(field, value) => {
                const property = appearance.find((p) => p.targets[0].field === field)!;
                try {
                  const next = clone(content);
                  patchReusablePart(
                    next,
                    part.nativeId,
                    nativePropertyPatch(next, part.nativeId, field, property.type, value),
                  );
                  setContent(next);
                  setContract({
                    ...contract,
                    properties: contract.properties.map((p) =>
                      p.targets.some((t) => t.partId === part.id && t.field === field)
                        ? { ...p, default: value }
                        : p,
                    ),
                  });
                  invalidate();
                  setError('');
                } catch (error) {
                  setError((error as Error).message);
                }
              }}
            />
          </fieldset>
        )}
        <ComponentStyleBindings
          domain={props.definition.domain as Domain}
          contract={contract}
          content={content}
          catalog={library}
          value={styles}
          onChange={(value) => {
            setStyles(value);
            invalidate();
          }}
          onWorking={setBusy}
        />
        <ComponentContractEditor
          contract={contract}
          content={content}
          onChange={(next) => {
            setContract(next);
            invalidate();
          }}
        />
        <button
          disabled={busy}
          onClick={() => {
            void run(async () => {
              const value = await candidate();
              setPreview(value.preview);
            });
          }}
        >
          新版をプレビュー
        </button>
        {preview && (
          <TemplatePreview domain={props.definition.payload.template.domain} content={preview} />
        )}
        <button
          disabled={busy || !props.catalog.saveReusableDraft}
          onClick={() => {
            void run(async () => {
              const value = await candidate();
              const draft: ReusableDraft = {
                id,
                revision: (saved?.revision ?? 0) + 1,
                ...(props.draft?.base
                  ? { base: props.draft.base }
                  : !props.draft
                    ? { base: definitionRef(props.definition) }
                    : {}),
                ref: definitionRef(value.definition),
                closure: value.closure,
              };
              await props.catalog.saveReusableDraft!(draft, saved?.revision ?? null);
              setSaved(draft);
              setDirty(false);
              setPreview(value.preview);
            });
          }}
        >
          下書きを保存
        </button>
        {saved && (
          <p role="status">
            保存済みの下書き: {saved.revision}
            {dirty ? '（未保存の変更あり）' : ''}
          </p>
        )}
        <button
          disabled={busy || !saved || dirty || !props.catalog.putBundle}
          onClick={() => {
            void run(async () => {
              if (!saved) return;
              await props.catalog.putBundle!({
                templates: [],
                reusable: [saved.closure],
                publishDraft: { id: saved.id, revision: saved.revision },
              });
              props.onSaved();
            });
          }}
        >
          保存した版を公開
        </button>
        {saved && (
          <button
            disabled={busy || !props.catalog.deleteReusableDraft}
            onClick={() => {
              void run(async () => {
                await props.catalog.deleteReusableDraft!(saved.id, saved.revision);
                props.onSaved();
              });
            }}
          >
            この下書きを削除
          </button>
        )}
      </div>
    </Dialog>
  );
}

export function draftDefinition(draft: ReusableDraft) {
  return closureDefinition<ComponentDefinition['payload']>(draft.closure, draft.ref);
}
