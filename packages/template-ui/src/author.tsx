import { useMemo, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import {
  expandTemplate,
  saveAsTemplate,
  selectTemplateContent,
  slotCandidates,
  type CatalogAdapter,
  type Domain,
  type NativeContent,
  type AuthoredSlot,
  type TemplateDefinition,
  TemplateError,
  type PrivateViewSettings,
  retainedComponent,
  compositionOwnsPath,
  type CompositionInput,
} from '@editor-platform/templates';
import { TemplatePreview } from './preview';
import { SaveComponentDialog } from './reuse';
export function SaveTemplateDialog(
  props: Parameters<typeof SaveLegacyTemplateDialog>[0] & {
    reuse?: boolean;
    privateSettings?: PrivateViewSettings;
    onComponentSaved?(): void;
  },
) {
  return props.reuse ? (
    <SaveComponentDialog {...props} onSaved={props.onComponentSaved} />
  ) : (
    <SaveLegacyTemplateDialog {...props} />
  );
}
function SaveLegacyTemplateDialog({
  domain,
  content,
  ids,
  slideSelection,
  catalog,
  onClose,
  onSaved,
}: {
  domain: Domain;
  content: NativeContent;
  ids: string[];
  slideSelection?: { pageId: string; elementId: string }[];
  catalog: CatalogAdapter;
  onClose(): void;
  onSaved?(definition: TemplateDefinition): void;
}) {
  const [kind, setKind] = useState<'whole' | 'fragment'>('whole'),
    [name, setName] = useState('マイテンプレート'),
    [purpose, setPurpose] = useState('繰り返し使う構造と内容'),
    [category, setCategory] = useState('個人'),
    [slots, setSlots] = useState<Record<string, AuthoredSlot>>({}),
    [preview, setPreview] = useState<TemplateDefinition>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [versionSource, setVersionSource] = useState<TemplateDefinition>();
  const [compose, setCompose] = useState(false),
    [memberModes, setMemberModes] = useState<Record<string, 'copy' | 'linked'>>({}),
    [componentInputs, setComponentInputs] = useState<Record<string, CompositionInput>>({});
  const chosen = useMemo(() => {
    try {
      return selectTemplateContent(
        domain,
        content,
        kind === 'fragment' ? ids : undefined,
        slideSelection,
      );
    } catch {
      return content;
    }
  }, [domain, content, ids, kind, slideSelection]);
  const members = 'reuse' in chosen ? (chosen.reuse?.instances ?? []) : [];
  const candidates = useMemo(
    () => slotCandidates(chosen).filter((c) => !compose || !compositionOwnsPath(chosen, c.path)),
    [chosen, compose],
  );
  const [personal, setPersonal] = useState<TemplateDefinition[]>([]);
  const edit = () => {
    setPreview(undefined);
    setError('');
  };
  const prepare = async () => {
    setBusy(true);
    setError('');
    try {
      const d = await saveAsTemplate({
        domain,
        content,
        ids: kind === 'fragment' ? ids : undefined,
        slideSelection,
        kind,
        name,
        purpose,
        category,
        slots: Object.values(slots),
        templateId: versionSource?.templateId,
        version: versionSource ? versionSource.templateVersion + 1 : 1,
        ...(compose
          ? {
              composition: {
                members: memberModes,
                inputs: Object.values(componentInputs),
                libraryId: versionSource?.composition?.libraryId,
              },
            }
          : {}),
      });
      setPreview(d);
    } catch (e) {
      setError(
        e instanceof TemplateError && e.diagnostics.length
          ? e.diagnostics.map((d) => `${d.path}: ${d.message}`).join(' / ')
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="テンプレートとして保存" onClose={onClose}>
      <div className="tp-author">
        <p>
          選択したcontent・style・必要な画像を保存します。コメント・履歴・actor情報は含めません。本文に残る個別情報はプレビューで確認してください。
        </p>
        <p>
          全体は新しい成果物、部分は選択した構造の挿入に使います。スタイル・表示プリセットは既存の設定だけを変更します。
          OfficeのmasterやWordスタイルを保持した差し込み出力ではありません。
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="tp-workspace">
          <div className="tp-form-column">
            <label>
              保存範囲
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as 'whole' | 'fragment');
                  setSlots({});
                  setCompose(false);
                  setMemberModes({});
                  setComponentInputs({});
                  edit();
                }}
              >
                <option value="whole">成果物全体</option>
                <option value="fragment" disabled={!ids.length}>
                  選択範囲の部分テンプレート
                </option>
              </select>
            </label>
            {!!members.length && (
              <fieldset>
                <legend>部品を組み合わせて保存</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={compose}
                    onChange={(e) => {
                      setCompose(e.target.checked);
                      setSlots({});
                      edit();
                    }}
                  />
                  部品の参照と公開入力を含める
                </label>
                <p>
                  コピーは独立した内容、リンクは採用した版と入力・スロットを保持します。リンクを保存するには部品全体を選択してください。
                </p>
                {compose &&
                  members.map((instance, index) => {
                    const { definition } = retainedComponent(chosen, instance.id);
                    const label = `${definition.name} ${index + 1}`;
                    return (
                      <fieldset key={instance.id}>
                        <legend>
                          {label}（v{instance.ref.version}）
                        </legend>
                        <label>
                          再利用方法
                          <select
                            aria-label={`${label}の再利用方法`}
                            value={memberModes[instance.id] ?? 'copy'}
                            onChange={(e) => {
                              setMemberModes({
                                ...memberModes,
                                [instance.id]: e.target.value as 'copy' | 'linked',
                              });
                              edit();
                            }}
                          >
                            <option value="copy">独立したコピー</option>
                            <option value="linked">版を保持したリンク</option>
                          </select>
                        </label>
                        <details>
                          <summary>公開入力を選ぶ</summary>
                          {definition.payload.contract.properties.map((property, propertyIndex) => {
                            const key = `${instance.id}:${property.id}`,
                              input = componentInputs[key];
                            return (
                              <div key={property.id}>
                                <label>
                                  <input
                                    type="checkbox"
                                    aria-label={`${label}：${property.label}を入力にする`}
                                    checked={!!input}
                                    onChange={(e) => {
                                      const next = { ...componentInputs };
                                      if (e.target.checked)
                                        next[key] = {
                                          key: `member${index + 1}_${propertyIndex + 1}`,
                                          label: `${label} ${property.label}`,
                                          instanceId: instance.id,
                                          propertyId: property.id,
                                        };
                                      else delete next[key];
                                      setComponentInputs(next);
                                      edit();
                                    }}
                                  />
                                  {property.label}（{property.type}）
                                </label>
                                {input && (
                                  <label>
                                    入力ラベル
                                    <input
                                      aria-label={`Component input label ${index + 1}-${propertyIndex + 1}`}
                                      value={input.label}
                                      onChange={(e) => {
                                        setComponentInputs({
                                          ...componentInputs,
                                          [key]: { ...input, label: e.target.value },
                                        });
                                        edit();
                                      }}
                                    />
                                  </label>
                                )}
                              </div>
                            );
                          })}
                        </details>
                        <p>
                          {definition.payload.contract.slots.length}
                          個の宣言済みスロットと、その中の内容を保持します。
                        </p>
                      </fieldset>
                    );
                  })}
              </fieldset>
            )}
            <label>
              テンプレート名
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  edit();
                }}
              />
            </label>
            <label>
              用途
              <textarea
                value={purpose}
                onChange={(e) => {
                  setPurpose(e.target.value);
                  edit();
                }}
              />
            </label>
            <label>
              カテゴリー
              <input
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  edit();
                }}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                void catalog
                  .list({ domain })
                  .then(setPersonal)
                  .catch((e) => setError(String(e)))
              }
            >
              既存テンプレートの新版を保存
            </button>
            {personal.length > 0 && (
              <label>
                改訂元
                <select
                  aria-label="改訂元テンプレート"
                  value={versionSource?.templateId ?? ''}
                  onChange={(e) => {
                    setVersionSource(personal.find((d) => d.templateId === e.target.value));
                    edit();
                  }}
                >
                  <option value="">新しいテンプレート</option>
                  {personal.map((d) => (
                    <option key={d.templateId} value={d.templateId}>
                      {d.name} v{d.templateVersion} → v{d.templateVersion + 1}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset>
              <legend>差し替え可能な入力slot</legend>
              <p>
                GUIではテキスト・画像・行リストを設定できます。リストの差し替えは入れ子も含めて置き換えます。
                画像内の文字はテキストslotにはなりません。高度なbindingはHost向けAPIで定義します。
              </p>
              {candidates.map((c, i) => {
                const key = c.path.join('.'),
                  slot = slots[key];
                return (
                  <div className="tp-slot" key={key}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!slot}
                        onChange={(e) => {
                          const next = { ...slots };
                          if (e.target.checked)
                            next[key] = {
                              path: c.path,
                              key: `slot${i + 1}`,
                              label: c.label,
                              type: c.type,
                            };
                          else delete next[key];
                          setSlots(next);
                          edit();
                        }}
                      />
                      {c.label} ({c.type})
                    </label>
                    {slot && (
                      <>
                        <label>
                          入力ラベル
                          <input
                            aria-label={`Slot label ${i + 1}`}
                            value={slot.label}
                            onChange={(e) => {
                              setSlots({ ...slots, [key]: { ...slot, label: e.target.value } });
                              edit();
                            }}
                          />
                        </label>
                        {c.type === 'text' && (
                          <label>
                            入力の種類
                            <select
                              aria-label={`Slot type ${i + 1}`}
                              value={slot.type}
                              onChange={(e) => {
                                setSlots({
                                  ...slots,
                                  [key]: { ...slot, type: e.target.value as 'text' | 'list' },
                                });
                                edit();
                              }}
                            >
                              <option value="text">テキスト</option>
                              <option value="list">行ごとのリスト</option>
                            </select>
                          </label>
                        )}
                        <label>
                          初期値・サンプル
                          {c.type === 'asset' ? (
                            <input
                              type="file"
                              accept="image/*"
                              aria-label={`Slot sample ${i + 1}`}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const reader = new FileReader();
                                reader.onload = () => {
                                  setSlots({
                                    ...slots,
                                    [key]: {
                                      ...slot,
                                      defaultValue: String(reader.result),
                                      example: String(reader.result),
                                    },
                                  });
                                  edit();
                                };
                                reader.readAsDataURL(file);
                              }}
                            />
                          ) : (
                            <textarea
                              aria-label={`Slot sample ${i + 1}`}
                              value={
                                Array.isArray(slot.defaultValue ?? c.value)
                                  ? ((slot.defaultValue ?? c.value) as string[]).join('\n')
                                  : String(slot.defaultValue ?? c.value)
                              }
                              onChange={(e) => {
                                const value =
                                  slot.type === 'list'
                                    ? e.target.value.split('\n')
                                    : e.target.value;
                                setSlots({
                                  ...slots,
                                  [key]: { ...slot, defaultValue: value, example: value },
                                });
                                edit();
                              }}
                            />
                          )}
                        </label>
                      </>
                    )}
                  </div>
                );
              })}
            </fieldset>
            <button type="button" disabled={busy} onClick={() => void prepare()}>
              保存内容をプレビュー
            </button>
          </div>
          <div className="tp-preview-column">
            <TemplatePreview
              domain={domain}
              content={preview ? expandTemplate(preview, preview.sample).content : chosen}
            />
            {preview && (
              <>
                <p>
                  {preview.name} v{preview.templateVersion} · {preview.inputs.length} slots
                </p>
                {preview.composition && (
                  <p>
                    {preview.kind === 'whole' ? 'Template' : 'Pattern'}：リンク{' '}
                    {preview.composition.members.filter((m) => m.reuse === 'linked').length}部品 /
                    コピー {preview.composition.members.filter((m) => m.reuse === 'copy').length}
                    部品
                  </p>
                )}
                <p role="note">
                  slotに選ばなかった本文・画像は固定内容として残ります。サンプルと固定内容の個別案件情報を確認してください。
                  画像は1点8 MiB相当、合計16 MiB相当の文字数、定義24 MiB、pack32 MiBまでです。
                </p>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void catalog
                      .put(preview)
                      .then(() => {
                        onSaved?.(preview);
                        onClose();
                      })
                      .catch((e) => setError(String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  テンプレートを保存
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
