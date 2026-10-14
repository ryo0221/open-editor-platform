import { useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import {
  isStructureInstance,
  readStructure,
  readStructureAppearance,
  prepareStructureChange,
  publishStructureVersion,
  prepareNativeApplication,
  localTemplateSnapshot,
  previewSharedTemplate,
  applySharedTemplate,
  type InputValue,
  type StructureLayout,
  type PreparedApplication,
  type TemplateDefinition,
  TemplateError,
  type StructureChange,
} from '@editor-platform/templates';
import type { TemplateGalleryProps } from './gallery';
import { TemplatePreview } from './preview';
type Values = {
  items: { id: string; [key: string]: InputValue }[];
  layout: StructureLayout;
  relationship: 'copy' | 'linked';
  appearance?: StructureChange['appearance'];
};
type Target = NonNullable<TemplateGalleryProps['target']>;
export function TemplateStructurePanel(props: {
  target: Target;
  catalog: TemplateGalleryProps['catalog'];
  local?: TemplateGalleryProps['local'];
  readOnly?: boolean;
  onApply: NonNullable<TemplateGalleryProps['onApply']>;
  onClose(): void;
}) {
  const instances =
    'reuse' in props.target.content
      ? (props.target.content.reuse?.instances.filter(isStructureInstance) ?? [])
      : [];
  const [selected, setSelected] = useState(instances[0]?.id ?? ''),
    [changes, setChanges] = useState<Values>();
  const [prepared, setPrepared] = useState<{ application: PreparedApplication; token?: string }>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [latest, setLatest] = useState<TemplateDefinition>();
  let current: ReturnType<typeof readStructure> | undefined,
    nativeAppearance: ReturnType<typeof readStructureAppearance> = [],
    readError = '';
  try {
    if (selected) {
      current = readStructure(props.target.content, selected);
      nativeAppearance = readStructureAppearance(props.target.content, selected);
    }
  } catch (e) {
    readError = (e as Error).message;
  }
  const values: Values | undefined =
    changes ??
    (current && {
      items: current.items.map((i) => ({ id: i.id })),
      layout: current.layout,
      relationship: current.relationship,
    });
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof TemplateError
          ? `${e.message}\n${e.diagnostics.map((d) => `${d.path}: ${d.message}`).join('\n')}`
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  const basis = () => {
    if (props.target.shared?.pendingCount)
      throw new Error('入力の同期完了後にプレビューしてください。');
    return {
      state:
        props.target.shared?.confirmed ??
        localTemplateSnapshot(props.target.artifactId, props.target.domain, props.target.content),
      identity: props.target.shared?.adapter.identity ?? {
        actorId: 'local',
        clientId: 'local',
        sessionId: 'local',
      },
    };
  };
  const change = (next: NonNullable<typeof values>) => {
    setChanges(next);
    setPrepared(undefined);
  };
  const stage = async (application: PreparedApplication) => {
    const preview = props.target.shared
      ? await previewSharedTemplate(application, props.target.shared)
      : undefined;
    setPrepared({ application, token: preview?.token });
  };
  return (
    <Dialog title="項目数・配置を変更" onClose={props.onClose}>
      <div className="tp-author">
        <p>
          本文・画像・書式は成果物上で直接編集できます。ここでは項目の追加・削除・順序・配置を変更します。
        </p>
        {(error || readError) && <p role="alert">{error || readError}</p>}
        {notice && <p role="status">{notice}</p>}
        <label>
          構成
          <select
            aria-label="編集する構成"
            value={selected}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value);
              setChanges(undefined);
              setPrepared(undefined);
              setError('');
              setLatest(undefined);
            }}
          >
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.ref.definitionId} · v{i.ref.version}
              </option>
            ))}
          </select>
        </label>
        {current && values && (
          <fieldset disabled={busy || props.readOnly}>
            <legend>
              {current.definition.name} · {current.definition.structure!.unit}
            </legend>
            <p>
              原本 v{current.definition.templateVersion}。既存項目の本文と個別調整を保持します。
            </p>
            <label>
              原本との関係
              <select
                aria-label="原本との関係"
                value={values.relationship}
                onChange={(e) =>
                  change({ ...values, relationship: e.target.value as 'copy' | 'linked' })
                }
              >
                <option value="copy">独立したコピー</option>
                <option value="linked">リンク（更新は確認して採用）</option>
              </select>
            </label>
            <label>
              配置
              <select
                aria-label="構成の配置"
                value={values.layout}
                onChange={(e) => change({ ...values, layout: e.target.value as StructureLayout })}
              >
                {current.definition.inputs
                  .find((f) => f.key === current!.definition.structure!.layoutSlot)
                  ?.options?.map((o) => (
                    <option key={o} value={o}>
                      {o === 'auto' ? '自動' : o === 'horizontal' ? '横' : '縦'}
                    </option>
                  ))}
              </select>
            </label>
            <ol className="tp-structure-items">
              {values.items.map((item, i) => (
                <li key={item.id}>
                  <span>
                    {current!.items.find((old) => old.id === item.id)?.label ?? String(item.title)}{' '}
                    <small>{item.id}</small>
                  </span>
                  {nativeAppearance.some((a) => a.id === item.id) && (
                    <div className="tp-item-appearance">
                      {(['emphasized', 'descriptionVisible', 'imageVisible'] as const).map(
                        (key) => (
                          <label key={key}>
                            <input
                              type="checkbox"
                              aria-label={`${item.id}の${key === 'emphasized' ? '見出しを強調' : key === 'descriptionVisible' ? '説明を表示' : '画像を表示'}`}
                              checked={
                                values.appearance?.find((a) => a.id === item.id)?.[key] ??
                                nativeAppearance.find((a) => a.id === item.id)![key]
                              }
                              onChange={(e) => {
                                const previous = values.appearance?.find(
                                  (a) => a.id === item.id,
                                ) ?? { id: item.id };
                                change({
                                  ...values,
                                  appearance: [
                                    ...(values.appearance ?? []).filter((a) => a.id !== item.id),
                                    { ...previous, [key]: e.target.checked },
                                  ],
                                });
                              }}
                            />
                            {key === 'emphasized'
                              ? '見出しを強調'
                              : key === 'descriptionVisible'
                                ? '説明を表示'
                                : '画像を表示'}
                          </label>
                        ),
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label={`${item.id}を上へ`}
                    disabled={i === 0}
                    onClick={() => {
                      const next = [...values.items];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      change({ ...values, items: next });
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`${item.id}を下へ`}
                    disabled={i === values.items.length - 1}
                    onClick={() => {
                      const next = [...values.items];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      change({ ...values, items: next });
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`${item.id}を削除候補にする`}
                    disabled={values.items.length <= current!.definition.structure!.min}
                    onClick={() =>
                      change({
                        ...values,
                        items: values.items.filter((v) => v.id !== item.id),
                        appearance: values.appearance?.filter((a) => a.id !== item.id),
                      })
                    }
                  >
                    削除候補
                  </button>
                </li>
              ))}
            </ol>
            {current.items
              .filter((i) => !values.items.some((item) => item.id === i.id))
              .map((i) => (
                <p key={i.id}>
                  削除予定: {i.label} ({i.id})。プレビューで要素・参照への影響を確認してください。
                </p>
              ))}
            <button
              type="button"
              disabled={values.items.length >= current.definition.structure!.max}
              onClick={() => {
                const slot =
                    current!.definition.repeats[current!.definition.structure!.repeat].slot,
                  first = (current!.definition.sample[slot] as Record<string, InputValue>[])[0],
                  labels = new Set([
                    ...current!.items.map((item) => item.label),
                    ...values.items.map((item) => String(item.title ?? '')),
                  ]);
                let title = '新しい項目',
                  ordinal = 1;
                while (labels.has(title)) title = `新しい項目 ${++ordinal}`;
                change({
                  ...values,
                  items: [
                    ...values.items,
                    {
                      ...structuredClone(first),
                      id: `i-${crypto.randomUUID()}`,
                      title,
                    },
                  ],
                });
              }}
            >
              項目を追加
            </button>
            <button
              type="button"
              onClick={() =>
                void run(async () =>
                  stage(
                    await prepareStructureChange({ ...basis(), instanceId: selected, ...values }),
                  ),
                )
              }
            >
              構成変更をプレビュー
            </button>
            {props.local && (
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    const d = await publishStructureVersion(
                      props.target.content,
                      selected,
                      props.local!,
                    );
                    setNotice(
                      `原本 v${d.templateVersion}を公開しました。既存の配置には自動反映しません。`,
                    );
                  })
                }
              >
                編集済みの構成を新しい原本の版として保存
              </button>
            )}
            {values.relationship === 'linked' && (
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    const found = (await props.catalog.list({ domain: props.target.domain })).find(
                      (d) => d.templateId === current!.definition.templateId,
                    );
                    setLatest(found);
                    setNotice(
                      found && found.templateVersion > current!.definition.templateVersion
                        ? `原本 v${found.templateVersion}の更新を確認できます。`
                        : '新しい公開版はありません。',
                    );
                  })
                }
              >
                原本の新しい版を確認
              </button>
            )}
            {latest && latest.templateVersion > current.definition.templateVersion && (
              <button
                type="button"
                onClick={() =>
                  void run(async () =>
                    stage(
                      await prepareStructureChange({
                        ...basis(),
                        instanceId: selected,
                        ...values,
                        definition: latest,
                      }),
                    ),
                  )
                }
              >
                原本更新の影響をプレビュー
              </button>
            )}
          </fieldset>
        )}
        {prepared && (
          <section>
            <h3>適用する変更</h3>
            {prepared.application.notices.map((n) => (
              <p key={n}>{n}</p>
            ))}
            <TemplatePreview domain={props.target.domain} content={prepared.application.preview} />
            <button
              type="button"
              disabled={busy || props.readOnly}
              onClick={() =>
                void run(async () => {
                  if (props.target.shared)
                    await applySharedTemplate(
                      prepared.application,
                      props.target.shared,
                      prepared.token!,
                    );
                  await props.onApply(prepared.application);
                  props.onClose();
                })
              }
            >
              この構成変更を適用
            </button>
          </section>
        )}
        <button
          type="button"
          disabled={busy || props.readOnly || !selected}
          onClick={() =>
            void run(async () => {
              const instance = instances.find((i) => i.id === selected)!;
              await stage(
                prepareNativeApplication({
                  ...basis(),
                  id: crypto.randomUUID(),
                  definition: {
                    templateId: instance.ref.definitionId,
                    templateVersion: instance.ref.version,
                    hash: instance.ref.hash,
                  },
                  summary: '構成の管理を解除して自由編集',
                  actions: [{ type: 'reuse.instance', target: selected, payload: { value: null } }],
                  notices: [
                    '本文・画像・配置は保持します。項目の自動再配置と原本の更新関係を解除します。',
                  ],
                }),
              );
            })
          }
        >
          構成の管理を解除して自由編集
        </button>
      </div>
    </Dialog>
  );
}
