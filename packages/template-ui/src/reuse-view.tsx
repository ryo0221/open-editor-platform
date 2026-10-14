import { useEffect, useMemo, useState } from 'react';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { Dialog } from '@editor-platform/editor-ui';
import {
  definitionRef,
  refKey,
  type LockedClosure,
  type ReusableDefinition,
} from '@editor-platform/reuse-core';
import {
  authorReusableViewPreset,
  closureDefinition,
  detachReusableViewPreset,
  exportTemplatePack,
  importTemplatePack,
  materializeReusableView,
  prepareReusableViewPreset,
  retainedViewPreset,
  validateReusableViewDefinition,
  TemplateCatalog,
  type CatalogAdapter,
  type InputValue,
  type PrivateViewSettings,
  type ReusableDraft,
  type ReusableViewDefinition,
  type ReusableViewPayload,
} from '@editor-platform/templates';
import { TemplateInputForm } from './form';
import type { ReusableLibraryProps } from './reuse';

function download(name: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function settingLabel(value: InputValue | undefined) {
  return value === true
    ? '有効'
    : value === false
      ? '無効'
      : value === 'page'
        ? 'ページ全体'
        : value === 'width'
          ? '表示幅'
          : String(value ?? '');
}
export function ReusableViewPresetEditor(props: {
  domain: 'review' | 'file';
  catalog: CatalogAdapter;
  privateSettings?: PrivateViewSettings;
  definition?: ReusableViewDefinition;
  closure?: LockedClosure<unknown>;
  draft?: ReusableDraft;
  onClose(): void;
  onSaved?(): void;
}) {
  const [name, setName] = useState(props.definition?.name ?? 'マイ表示設定');
  const [settings, setSettings] = useState<PrivateViewSettings>(() =>
    clone(props.definition?.payload.template.preset?.fields ?? props.privateSettings ?? {}),
  );
  const [body, setBody] = useState(
    props.definition?.payload.annotation.body ?? '確認してください。',
  );
  const [color, setColor] = useState(props.definition?.payload.annotation.color ?? '#336699');
  const [saved, setSaved] = useState(props.draft),
    [dirty, setDirty] = useState(!props.draft);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof materializeReusableView>>>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [id] = useState(props.draft?.id ?? 'draft_' + crypto.randomUUID());
  const [definitionId] = useState(props.definition?.definitionId ?? 'view_' + crypto.randomUUID());
  const library = useMemo(() => new TemplateCatalog([props.catalog]), [props.catalog]);
  const [styles, setStyles] = useState<ReusableDefinition<unknown>[]>([]);
  const [style, setStyle] = useState(props.definition?.payload.style);
  const [dependencies, setDependencies] = useState(props.closure?.definitions ?? []);
  useEffect(() => {
    let disposed = false;
    void library
      .listReusable({ domain: props.domain, kind: 'style' })
      .then((values) => {
        if (!disposed) setStyles(values);
      })
      .catch((error) => {
        if (!disposed) setError((error as Error).message);
      });
    return () => {
      disposed = true;
    };
  }, [library, props.domain]);
  const styleChoices = [
    ...new Map(
      [
        ...dependencies.filter((d) => d.kind === 'style' && d.domain === props.domain),
        ...styles,
      ].map((d) => [refKey(d), d]),
    ).values(),
  ];
  const fields =
    props.domain === 'review'
      ? [
          { key: 'split', label: '左右に分けて表示', type: 'boolean' as const, default: true },
          { key: 'wrap', label: '長い行を折り返す', type: 'boolean' as const, default: true },
          { key: 'annotations', label: '注釈を表示', type: 'boolean' as const, default: true },
        ]
      : [
          {
            key: 'fit',
            label: '原本の表示サイズ',
            type: 'enum' as const,
            default: 'page',
            options: ['page', 'width'],
          },
          { key: 'annotations', label: '注釈を表示', type: 'boolean' as const, default: true },
        ];
  const values = Object.fromEntries(fields.map((f) => [f.key, settings[f.key] ?? f.default]));
  const invalidate = () => {
    setDirty(true);
    setPreview(undefined);
  };
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
  const candidate = () =>
    authorReusableViewPreset({
      domain: props.domain,
      name,
      settings: values,
      annotation: { body, color },
      definitionId,
      libraryId: props.definition?.libraryId,
      version: props.definition ? props.definition.version + (props.draft ? 0 : 1) : 1,
      style,
      dependencies,
    });
  return (
    <Dialog title="表示設定の下書き・公開" onClose={props.onClose}>
      <div className="tp-author">
        <p>自分の表示と、新しい注釈の既定値を保存します。</p>
        {error && <p role="alert">{error}</p>}
        <label>
          設定名
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              invalidate();
            }}
          />
        </label>
        <TemplateInputForm
          fields={fields.map((field) => ({ ...field, description: '' }))}
          values={values}
          onChange={(value) => {
            setSettings(value);
            invalidate();
          }}
        />
        <label>
          新しい注釈の本文
          <textarea
            value={body}
            maxLength={20000}
            onChange={(e) => {
              setBody(e.target.value);
              invalidate();
            }}
          />
        </label>
        <label>
          新しい注釈の色
          <input
            type="color"
            disabled={!!style}
            value={color.slice(0, 7)}
            onChange={(e) => {
              setColor(e.target.value);
              invalidate();
            }}
          />
        </label>
        <label>
          新しい注釈に採用するスタイルの版
          <select
            value={style ? refKey(style) : ''}
            disabled={busy}
            onChange={(e) => {
              const key = e.target.value;
              if (!key) {
                setStyle(undefined);
                invalidate();
                return;
              }
              const selected = styleChoices.find((d) => refKey(d) === key)!;
              void run(async () => {
                const retained = dependencies.some(
                  (d) => refKey(d) === key && d.hash === selected.hash,
                );
                const closure = retained
                  ? dependencies
                  : (await library.closure(definitionRef(selected))).definitions;
                const combined = new Map<string, ReusableDefinition<unknown>>();
                for (const definition of [...dependencies, ...closure]) {
                  const old = combined.get(refKey(definition));
                  if (old && old.hash !== definition.hash)
                    throw new Error('同じ版のスタイル・トークンの内容が一致しません。');
                  combined.set(refKey(definition), definition);
                }
                setDependencies([...combined.values()]);
                setStyle(definitionRef(selected));
                invalidate();
              });
            }}
          >
            <option value="">指定した固定色を使う</option>
            {styleChoices.map((d) => (
              <option key={refKey(d)} value={refKey(d)}>
                {d.name} v{d.version}
              </option>
            ))}
          </select>
        </label>
        {style && <p>注釈の色には、この版が参照するスタイルを使います。</p>}
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const value = await candidate();
              setPreview(await materializeReusableView(value.definition, value.closure));
            })
          }
        >
          表示設定をプレビュー
        </button>
        {preview && (
          <section aria-label="表示設定のプレビュー">
            <dl>
              {fields.map((f) => (
                <div key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>{settingLabel(preview.settings[f.key])}</dd>
                </div>
              ))}
            </dl>
            <p
              style={{
                borderLeft: `4px solid ${preview.annotation.color ?? '#336699'}`,
                paddingLeft: 8,
              }}
            >
              {preview.annotation.body}
            </p>
          </section>
        )}
        <button
          disabled={busy || !props.catalog.saveReusableDraft}
          onClick={() =>
            void run(async () => {
              const value = await candidate();
              const next: ReusableDraft = {
                id,
                revision: (saved?.revision ?? 0) + 1,
                ...(props.draft?.base
                  ? { base: props.draft.base }
                  : props.definition && !props.draft
                    ? { base: definitionRef(props.definition) }
                    : {}),
                ref: definitionRef(value.definition),
                closure: value.closure,
              };
              await props.catalog.saveReusableDraft!(next, saved?.revision ?? null);
              setSaved(next);
              setDirty(false);
              setPreview(await materializeReusableView(value.definition, value.closure));
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
          disabled={busy || !saved || dirty || !props.catalog.putBundle}
          onClick={() =>
            void run(async () => {
              await props.catalog.putBundle!({
                templates: [],
                reusable: [saved!.closure],
                publishDraft: { id: saved!.id, revision: saved!.revision },
              });
              props.onSaved?.();
              props.onClose();
            })
          }
        >
          保存した版を公開
        </button>
        {saved && (
          <button
            disabled={busy || !props.catalog.deleteReusableDraft}
            onClick={() =>
              void run(async () => {
                await props.catalog.deleteReusableDraft!(saved.id, saved.revision);
                props.onClose();
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

export function ReusableViewLibrary(props: ReusableLibraryProps) {
  const { target } = props;
  const current = props.privateSettings ?? {};
  const [items, setItems] = useState<ReusableViewDefinition[]>([]),
    [drafts, setDrafts] = useState<ReusableDraft[]>([]);
  const [archived, setArchived] = useState<string[]>([]),
    [includeArchived, setIncludeArchived] = useState(false);
  const [retained, setRetained] = useState<Awaited<ReturnType<typeof retainedViewPreset>>>();
  const [selected, setSelected] = useState<ReusableViewDefinition>(),
    [closure, setClosure] = useState<LockedClosure<unknown>>();
  const [values, setValues] = useState<PrivateViewSettings>({}),
    [inputs, setInputs] = useState<Record<string, InputValue>>({});
  const [resets, setResets] = useState<string[]>([]),
    [mode, setMode] = useState('');
  const [reuse, setReuse] = useState<'linked' | 'copy'>('linked');
  const [prepared, setPrepared] = useState<{
    basis: string;
    result: Awaited<ReturnType<typeof prepareReusableViewPreset>>;
  }>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{
    definition: ReusableViewDefinition;
    closure: LockedClosure<unknown>;
    draft?: ReusableDraft;
  }>();
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      props.catalog.listReusable({
        domain: target.domain,
        kind: 'view-preset',
        archived: includeArchived,
      }),
      props.catalog.listReusable({ domain: target.domain, kind: 'view-preset' }),
      props.writeCatalog?.listReusableDrafts?.() ?? Promise.resolve([]),
    ])
      .then(async ([all, active, drafts]) => {
        const checked = await Promise.all(all.map(validateReusableViewDefinition));
        if (cancelled) return;
        setItems(checked);
        setArchived(all.filter((d) => !active.some((a) => refKey(a) === refKey(d))).map(refKey));
        setDrafts(
          drafts.filter((d) => d.ref.domain === target.domain && d.ref.kind === 'view-preset'),
        );
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.catalog, props.writeCatalog, target.domain, includeArchived, refresh]);
  useEffect(() => {
    let cancelled = false;
    void retainedViewPreset(props.privateSettings ?? {})
      .then((value) => {
        if (!cancelled) setRetained(value);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.privateSettings]);
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
  const select = async (d: ReusableViewDefinition, c?: LockedClosure<unknown>, adopted = false) => {
    const next = c ?? (await props.catalog.closure(definitionRef(d)));
    const resolved = await materializeReusableView(
      d,
      next,
      adopted ? retained?.adoption.inputs : undefined,
      adopted ? retained?.adoption.mode : undefined,
    );
    setSelected(d);
    setClosure(next);
    setPrepared(undefined);
    setInputs({});
    setResets([]);
    setMode(adopted ? (retained?.adoption.mode ?? '') : '');
    setValues(adopted ? { ...resolved.settings, ...current } : resolved.settings);
  };
  if (editing && props.writeCatalog)
    return (
      <ReusableViewPresetEditor
        {...editing}
        domain={target.domain as 'review' | 'file'}
        catalog={props.writeCatalog}
        onClose={() => {
          setEditing(undefined);
          setRefresh((n) => n + 1);
        }}
        onSaved={() => {
          setSelected(undefined);
          setPrepared(undefined);
        }}
      />
    );
  return (
    <Dialog title="表示設定ライブラリ" onClose={props.onClose}>
      <div className="tp-gallery">
        {error && <p role="alert">{error}</p>}
        <p>自分の表示・注釈作成設定です。改訂版は内容を確認して採用します。</p>
        <div className="tp-workspace">
          <div className="tp-form-column">
            {retained && (
              <section aria-label="採用中の表示設定">
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() => select(retained.definition, retained.closure, true))
                  }
                >
                  採用中: {retained.definition.name} v{retained.definition.version}
                </button>
                <p>この版を保持しています。</p>
                <button
                  disabled={busy || !props.onPrivateSettings}
                  onClick={() =>
                    void run(async () => {
                      await props.onPrivateSettings!(
                        detachReusableViewPreset(current),
                        canonicalJson(current),
                      );
                      setPrepared(undefined);
                    })
                  }
                >
                  表示設定のリンクを解除
                </button>
              </section>
            )}
            <label>
              表示設定を検索
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
                <button key={refKey(d)} disabled={busy} onClick={() => void run(() => select(d))}>
                  {d.name} v{d.version}
                  {archived.includes(refKey(d)) ? '（アーカイブ済み）' : ''}
                </button>
              ))}
            {items.length === 0 && <p>「表示設定を保存」から作成できます。</p>}
            {drafts.map((d) => (
              <button
                key={d.id}
                disabled={busy}
                onClick={() => {
                  setEditing({
                    definition: closureDefinition<ReusableViewPayload>(d.closure, d.ref),
                    closure: d.closure,
                    draft: d,
                  });
                }}
              >
                {closureDefinition<ReusableViewPayload>(d.closure, d.ref).name} — 下書き{' '}
                {d.revision}
              </button>
            ))}
            {props.writeCatalog && (
              <label>
                表示設定packを読み込む
                <input
                  type="file"
                  accept="application/json,.json"
                  disabled={busy}
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
          </div>
          <div className="tp-preview-column">
            {selected && closure && (
              <>
                <h3>
                  {selected.name} v{selected.version}
                </h3>
                <label>
                  表示設定の使い方
                  <select
                    value={reuse}
                    onChange={(e) => {
                      setReuse(e.target.value as 'linked' | 'copy');
                      setPrepared(undefined);
                    }}
                  >
                    <option value="linked">リンクして使用</option>
                    <option value="copy">コピーして使用</option>
                  </select>
                </label>
                <TemplateInputForm
                  fields={selected.payload.template.inputs}
                  values={values}
                  onChange={setValues}
                  onFieldChange={(key, value) => {
                    setInputs((old) => ({ ...old, [key]: value }));
                    setResets((old) => old.filter((k) => k !== key));
                    setPrepared(undefined);
                  }}
                />
                {selected.payload.style && (
                  <label>
                    注釈スタイルのモード
                    <select
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value);
                        setPrepared(undefined);
                      }}
                    >
                      <option value="">既定</option>
                      {Array.from(
                        new Set(
                          closure.definitions
                            .filter((d) => d.kind === 'tokens')
                            .flatMap((d) => {
                              const payload = d.payload as { modes?: string[] };
                              return payload.modes ?? [];
                            }),
                        ),
                      ).map((key) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {retained &&
                  selected.payload.template.inputs.map((f) => (
                    <label key={f.key}>
                      <input
                        type="checkbox"
                        checked={resets.includes(f.key)}
                        onChange={(e) => {
                          setResets((old) =>
                            e.target.checked ? [...old, f.key] : old.filter((k) => k !== f.key),
                          );
                          setInputs((old) => {
                            const next = { ...old };
                            delete next[f.key];
                            return next;
                          });
                          setPrepared(undefined);
                        }}
                      />
                      {f.label}を部品の既定値に戻す
                    </label>
                  ))}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const basis = canonicalJson(current);
                      const result = await prepareReusableViewPreset({
                        definition: selected,
                        closure,
                        current,
                        inputs,
                        reuse,
                        reset: resets,
                        mode: mode || null,
                      });
                      setPrepared({ basis, result });
                    })
                  }
                >
                  適用内容をプレビュー
                </button>
                {prepared && (
                  <section aria-label="表示設定の適用プレビュー">
                    <dl>
                      {selected.payload.template.inputs.map((f) => (
                        <div key={f.key}>
                          <dt>{f.label}</dt>
                          <dd>
                            {settingLabel(prepared.result.settings[f.key])}{' '}
                            {prepared.result.preserved.includes(f.key)
                              ? '（自分の設定を保持）'
                              : '（採用）'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p>{(prepared.result.settings.$annotation as { body: string }).body}</p>
                    {prepared.result.notices.map((notice) => (
                      <p key={notice}>{notice}</p>
                    ))}
                    <button
                      disabled={busy || !props.onPrivateSettings}
                      onClick={() =>
                        void run(async () => {
                          if (canonicalJson(current) !== prepared.basis)
                            throw new Error(
                              '表示設定が変更されました。もう一度プレビューしてください。',
                            );
                          await props.onPrivateSettings!(prepared.result.settings, prepared.basis);
                          props.onClose();
                        })
                      }
                    >
                      この表示設定を適用
                    </button>
                  </section>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      download(
                        `${selected.name}.view.template.json`,
                        await exportTemplatePack([], [closure]),
                      ),
                    )
                  }
                >
                  表示設定packを書き出す
                </button>
                {props.writeCatalog && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => setEditing({ definition: selected, closure })}
                    >
                      表示設定の新版を作成
                    </button>
                    <button
                      disabled={busy || !props.writeCatalog.archiveReusable}
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
                        : '表示設定をアーカイブ'}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
