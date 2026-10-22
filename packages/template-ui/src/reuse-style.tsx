import { useEffect, useState } from 'react';
import { clone } from '@editor-platform/artifact-core';
import { Dialog } from '@editor-platform/editor-ui';
import {
  definitionRef,
  refKey,
  resolveStyle,
  resolveTokens,
  styleCapabilities,
  type ReusableDefinition,
  type LockedClosure,
  type TokenSet,
  type DomainStyle,
} from '@editor-platform/reuse-core';
import {
  authorReusableStyle,
  authorReusableTokens,
  closureDefinition,
  exportTemplatePack,
  importTemplatePack,
  validateReusableClosure,
  type CatalogAdapter,
  type TemplateCatalog,
  type Domain,
  type ReusableDraft,
  type ReusableStylePayload,
} from '@editor-platform/templates';
import { emptyTokenSet, TokenSetForm } from './reuse-token-form';

interface LibraryProps {
  domain: Domain;
  catalog: TemplateCatalog;
  writeCatalog?: CatalogAdapter;
  readOnly?: boolean;
  onClose(): void;
}
type Editing = {
  kind: 'tokens' | 'style';
  definition?: ReusableDefinition<unknown>;
  closure?: LockedClosure<unknown>;
  draft?: ReusableDraft;
};
const exportPack = async (closure: LockedClosure<unknown>) => {
  const text = await exportTemplatePack([], [closure]);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'reusable-styles.json';
  link.click();
  URL.revokeObjectURL(url);
};
/** Search/publish uses the same catalog as native components and template packs. */
export function TokenStyleLibrary(props: LibraryProps) {
  const [items, setItems] = useState<ReusableDefinition<unknown>[]>([]),
    [drafts, setDrafts] = useState<ReusableDraft[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false),
    [archived, setArchived] = useState<string[]>([]);
  const [search, setSearch] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<{
    definition: ReusableDefinition<unknown>;
    closure: LockedClosure<unknown>;
  }>();
  const [editing, setEditing] = useState<Editing>();
  const [mode, setMode] = useState('');
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
  useEffect(() => {
    let disposed = false;
    const query = (archived = false) =>
      Promise.all([
        props.catalog.listReusable({ kind: 'tokens', archived }),
        props.catalog.listReusable({ kind: 'style', domain: props.domain, archived }),
      ]);
    void Promise.all([
      query(includeArchived),
      query(),
      props.writeCatalog?.listReusableDrafts?.() ?? [],
    ])
      .then(([lists, active, drafts]) => {
        if (disposed) return;
        setItems(lists.flat());
        setArchived(
          lists
            .flat()
            .filter((d) => !active.flat().some((a) => refKey(a) === refKey(d)))
            .map(refKey),
        );
        setDrafts(
          drafts.filter(
            (d) =>
              d.ref.kind === 'tokens' || (d.ref.kind === 'style' && d.ref.domain === props.domain),
          ),
        );
      })
      .catch((error) => {
        if (!disposed) setError((error as Error).message);
      });
    return () => {
      disposed = true;
    };
  }, [props.catalog, props.domain, props.writeCatalog, includeArchived, refresh]);
  if (editing && props.writeCatalog)
    return (
      <StyleDefinitionEditor
        {...props}
        writeCatalog={props.writeCatalog}
        {...editing}
        onClose={() => {
          setEditing(undefined);
          setRefresh((n) => n + 1);
        }}
        onSaved={() => {
          setEditing(undefined);
          setSelected(undefined);
          setRefresh((n) => n + 1);
        }}
      />
    );
  const tokens =
    selected &&
    (selected.definition.kind === 'tokens'
      ? (selected.definition.payload as TokenSet)
      : closureDefinition<TokenSet>(
          selected.closure,
          (selected.definition.payload as ReusableStylePayload).tokens,
        ).payload);
  let preview: Record<string, unknown> = {};
  try {
    if (selected && tokens)
      preview =
        selected.definition.kind === 'tokens'
          ? Object.fromEntries(
              Object.entries(resolveTokens(tokens, { instanceMode: mode || undefined }).tokens).map(
                ([id, t]) => [id, t.value],
              ),
            )
          : resolveStyle((selected.definition.payload as ReusableStylePayload).style, tokens, {
              instanceMode: mode || undefined,
            }).properties;
  } catch (error) {
    preview = { 診断: (error as Error).message };
  }
  return (
    <Dialog title="トークン・スタイル" onClose={props.onClose}>
      <div className="tp-author">
        {error && <p role="alert">{error}</p>}
        <p>
          共通のトークンと、このEditor用のスタイルを管理します。公開した改訂は利用先で選んで採用します。
        </p>
        <label>
          定義を検索
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
        <div className="tp-row">
          <button
            disabled={props.readOnly || !props.writeCatalog}
            onClick={() => setEditing({ kind: 'tokens' })}
          >
            トークンセットを作成
          </button>
          <button
            disabled={props.readOnly || !props.writeCatalog}
            onClick={() => setEditing({ kind: 'style' })}
          >
            スタイルを作成
          </button>
        </div>
        {items
          .filter((d) => d.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
          .map((d) => (
            <button
              key={refKey(d)}
              disabled={busy}
              aria-pressed={selected?.definition.hash === d.hash}
              onClick={() =>
                void run(async () => {
                  const closure = await props.catalog.closure(definitionRef(d));
                  await validateReusableClosure(closure);
                  setSelected({ definition: d, closure });
                  setMode('');
                })
              }
            >
              {d.name} v{d.version}
              {d.kind === 'tokens' ? '（共通トークン）' : '（スタイル）'}
              {archived.includes(refKey(d)) ? ' — アーカイブ済み' : ''}
            </button>
          ))}
        {drafts.length > 0 && <h3>保存した下書き</h3>}
        {drafts.map((draft) => (
          <button
            key={draft.id}
            disabled={props.readOnly || busy}
            onClick={() =>
              void run(async () => {
                await validateReusableClosure(draft.closure);
                setEditing({
                  kind: draft.ref.kind as 'tokens' | 'style',
                  definition: closureDefinition(draft.closure, draft.ref),
                  closure: draft.closure,
                  draft,
                });
              })
            }
          >
            {closureDefinition(draft.closure, draft.ref).name} — 下書き {draft.revision}
          </button>
        ))}
        {props.writeCatalog && (
          <label>
            再利用packを読み込む
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy || props.readOnly}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void run(async () => {
                    await importTemplatePack(await file.text(), props.writeCatalog!);
                    setRefresh((n) => n + 1);
                  });
              }}
            />
          </label>
        )}
        {selected && tokens && (
          <section aria-label="採用済みの定義を確認">
            <h3>
              {selected.definition.name} v{selected.definition.version}
            </h3>
            <label>
              確認するモード
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">既定（{tokens.defaultMode}）</option>
                {tokens.modes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <table>
              <thead>
                <tr>
                  <th>属性</th>
                  <th>解決した値</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(preview).map(([id, value]) => (
                  <tr key={id}>
                    <td>{id}</td>
                    <td>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tp-row">
              <button
                disabled={busy || props.readOnly || !props.writeCatalog}
                onClick={() =>
                  setEditing({ ...selected, kind: selected.definition.kind as 'tokens' | 'style' })
                }
              >
                新版の下書きを作成
              </button>
              <button disabled={busy} onClick={() => void run(() => exportPack(selected.closure))}>
                再利用packを書き出す
              </button>
              <button
                disabled={busy || props.readOnly || !props.writeCatalog?.archiveReusable}
                onClick={() =>
                  void run(async () => {
                    await props.writeCatalog!.archiveReusable!(
                      selected.definition.libraryId,
                      selected.definition.definitionId,
                      !archived.includes(refKey(selected.definition)),
                    );
                    setSelected(undefined);
                    setRefresh((n) => n + 1);
                  })
                }
              >
                {archived.includes(refKey(selected.definition))
                  ? 'アーカイブから戻す'
                  : '定義をアーカイブ'}
              </button>
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}

function resolveDefinitionPreview(preview: LockedClosure<unknown> | undefined, mode: string) {
  const previewRoot = preview && preview.definitions.find((d) => d.hash === preview.roots[0].hash)!;
  const previewTokens =
    previewRoot &&
    (previewRoot.kind === 'tokens'
      ? (previewRoot.payload as TokenSet)
      : closureDefinition<TokenSet>(preview!, (previewRoot.payload as ReusableStylePayload).tokens)
          .payload);
  let resolved: Record<string, unknown> = {};
  try {
    if (previewRoot && previewTokens)
      resolved =
        previewRoot.kind === 'tokens'
          ? Object.fromEntries(
              Object.entries(
                resolveTokens(previewTokens, { instanceMode: mode || undefined }).tokens,
              ).map(([id, t]) => [id, t.value]),
            )
          : resolveStyle((previewRoot.payload as ReusableStylePayload).style, previewTokens, {
              instanceMode: mode || undefined,
            }).properties;
  } catch (error) {
    resolved = { 診断: (error as Error).message };
  }
  return { previewTokens, resolved };
}

function draftBase(draft: ReusableDraft | undefined, old: ReusableDefinition<unknown> | undefined) {
  return draft?.base ? { base: draft.base } : old && !draft ? { base: definitionRef(old) } : {};
}

function StyleBindingFields(props: {
  domain: Domain;
  style: DomainStyle;
  tokenOptions: ReusableDefinition<TokenSet>[];
  tokenRefKey: string;
  chosen?: ReusableDefinition<TokenSet>;
  onTokenRef(key: string): void;
  onStyle(style: DomainStyle): void;
}) {
  const { style } = props;
  return (
    <>
      <label>
        参照するトークンの版
        <select value={props.tokenRefKey} onChange={(e) => props.onTokenRef(e.target.value)}>
          <option value="">選択</option>
          {props.tokenOptions.map((d) => (
            <option key={refKey(d)} value={refKey(d)}>
              {d.name} v{d.version}
            </option>
          ))}
        </select>
      </label>
      <p>
        {props.domain}
        の属性へ、型が一致するトークンを割り当てます。px/ptは媒体の単位へ変換します。
      </p>
      {Object.entries(styleCapabilities[style.domain]).map(([target, rule]) => (
        <label key={target}>
          {target}
          <select
            aria-label={`スタイル属性: ${target}`}
            value={style.bindings[target]?.token ?? ''}
            onChange={(e) => {
              const bindings = { ...style.bindings };
              if (e.target.value) bindings[target] = { token: e.target.value };
              else delete bindings[target];
              props.onStyle({ ...style, bindings });
            }}
          >
            <option value="">指定しない</option>
            {Object.entries(props.chosen?.payload.tokens ?? {})
              .filter(([, t]) => t.type === rule.type)
              .map(([id]) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
          </select>
        </label>
      ))}
    </>
  );
}

function DefinitionPreview(props: {
  tokens: TokenSet;
  resolved: Record<string, unknown>;
  mode: string;
  onMode(mode: string): void;
}) {
  return (
    <section aria-label="定義のプレビュー">
      <label>
        確認するモード
        <select value={props.mode} onChange={(e) => props.onMode(e.target.value)}>
          <option value="">既定（{props.tokens.defaultMode}）</option>
          {props.tokens.modes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <table>
        <thead>
          <tr>
            <th>属性</th>
            <th>解決した値</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(props.resolved).map(([key, value]) => (
            <tr key={key}>
              <td>{key}</td>
              <td>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StyleDefinitionEditor(
  props: LibraryProps & Editing & { writeCatalog: CatalogAdapter; onSaved(): void },
) {
  const old = props.definition;
  const [name, setName] = useState(
    old?.name ?? (props.kind === 'tokens' ? 'ブランド' : 'ブランドスタイル'),
  );
  const [tokens, setTokens] = useState<TokenSet>(() =>
    clone(props.kind === 'tokens' && old ? (old.payload as TokenSet) : emptyTokenSet()),
  );
  const [style, setStyle] = useState<DomainStyle>(() =>
    clone(
      props.kind === 'style' && old
        ? (old.payload as ReusableStylePayload).style
        : { schemaVersion: 1, domain: props.domain, bindings: {} },
    ),
  );
  const initialRef =
    props.kind === 'style' && old ? (old.payload as ReusableStylePayload).tokens : undefined;
  const [tokenOptions, setTokenOptions] = useState<ReusableDefinition<TokenSet>[]>([]);
  const [tokenRefKey, setTokenRefKey] = useState(initialRef ? refKey(initialRef) : '');
  const [tokenClosure, setTokenClosure] = useState(props.closure);
  const [saved, setSaved] = useState(props.draft),
    [dirty, setDirty] = useState(!props.draft);
  const [preview, setPreview] = useState<LockedClosure<unknown>>(),
    [mode, setMode] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [id] = useState(props.draft?.id ?? 'draft_' + crypto.randomUUID());
  const [definitionId] = useState(old?.definitionId ?? props.kind + '_' + crypto.randomUUID());
  const changed = () => {
    setDirty(true);
    setPreview(undefined);
  };
  useEffect(() => {
    if (props.kind !== 'style') return;
    let disposed = false;
    void props.catalog
      .listReusable({ kind: 'tokens' })
      .then((values) => {
        const exact =
          initialRef && props.closure
            ? closureDefinition<TokenSet>(props.closure, initialRef)
            : undefined;
        if (!disposed)
          setTokenOptions([
            ...new Map(
              [...(exact ? [exact] : []), ...(values as ReusableDefinition<TokenSet>[])].map(
                (d) => [refKey(d), d],
              ),
            ).values(),
          ]);
      })
      .catch((error) => {
        if (!disposed) setError((error as Error).message);
      });
    return () => {
      disposed = true;
    };
  }, [props.catalog, props.kind]);
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
  const candidate = async () => {
    const identity = {
      name,
      definitionId,
      libraryId: old?.libraryId ?? 'personal',
      version: props.draft ? old!.version : (old?.version ?? 0) + 1,
    };
    if (props.kind === 'tokens') return authorReusableTokens({ ...identity, tokens });
    const chosen = tokenOptions.find((d) => refKey(d) === tokenRefKey);
    if (!chosen || !tokenClosure) throw new Error('参照するトークンの版を選択してください。');
    return authorReusableStyle({
      ...identity,
      style,
      tokens: definitionRef(chosen),
      dependencies: tokenClosure.definitions,
    });
  };
  const chosen = tokenOptions.find((d) => refKey(d) === tokenRefKey);
  const { previewTokens, resolved } = resolveDefinitionPreview(preview, mode);
  return (
    <Dialog title="トークン・スタイルの下書き" onClose={props.onClose}>
      <div className="tp-author">
        {error && <p role="alert">{error}</p>}
        <label>
          定義名
          <input
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              changed();
            }}
          />
        </label>
        <fieldset disabled={busy || props.readOnly}>
          {props.kind === 'tokens' ? (
            <TokenSetForm
              value={tokens}
              onChange={(value) => {
                setTokens(value);
                changed();
              }}
            />
          ) : (
            <StyleBindingFields
              domain={props.domain}
              style={style}
              tokenOptions={tokenOptions}
              tokenRefKey={tokenRefKey}
              chosen={chosen}
              onTokenRef={(key) => {
                setTokenRefKey(key);
                setTokenClosure(undefined);
                changed();
                const selected = tokenOptions.find((d) => refKey(d) === key);
                if (selected)
                  void run(async () =>
                    setTokenClosure(await props.catalog.closure(definitionRef(selected))),
                  );
              }}
              onStyle={(value) => {
                setStyle(value);
                changed();
              }}
            />
          )}
        </fieldset>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const value = await candidate();
              setPreview(value.closure);
              setMode('');
            })
          }
        >
          定義をプレビュー
        </button>
        {previewTokens && (
          <DefinitionPreview
            tokens={previewTokens}
            resolved={resolved}
            mode={mode}
            onMode={setMode}
          />
        )}
        <button
          disabled={busy || props.readOnly || !props.writeCatalog.saveReusableDraft}
          onClick={() =>
            void run(async () => {
              const value = await candidate();
              const draft: ReusableDraft = {
                id,
                revision: (saved?.revision ?? 0) + 1,
                ...draftBase(props.draft, old),
                ref: definitionRef(value.definition),
                closure: value.closure,
              };
              await props.writeCatalog.saveReusableDraft!(draft, saved?.revision ?? null);
              setSaved(draft);
              setDirty(false);
              setPreview(value.closure);
              setMode('');
            })
          }
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
          disabled={busy || props.readOnly || !saved || dirty || !props.writeCatalog.putBundle}
          onClick={() =>
            void run(async () => {
              await props.writeCatalog.putBundle!({
                templates: [],
                reusable: [saved!.closure],
                publishDraft: { id: saved!.id, revision: saved!.revision },
              });
              props.onSaved();
            })
          }
        >
          保存した版を公開
        </button>
        {saved && (
          <button
            disabled={busy || props.readOnly || !props.writeCatalog.deleteReusableDraft}
            onClick={() =>
              void run(async () => {
                await props.writeCatalog.deleteReusableDraft!(saved.id, saved.revision);
                props.onSaved();
              })
            }
          >
            この下書きを削除
          </button>
        )}
      </div>
    </Dialog>
  );
}
