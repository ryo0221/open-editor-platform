import { useState } from 'react';
import { definitionRef } from '@editor-platform/reuse-core';
import {
  previewComponentUpdate,
  retainedComponent,
  reusablePrototype,
  type ComponentDefinition,
  type ComponentUpdatePreview,
  type ComponentUpdateSelection,
  type NativeContent,
  type PreparedApplication,
  type TemplateCatalog,
} from '@editor-platform/templates';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { DataMigrationForm } from './reuse-data';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import type { Identity, Snapshot } from '@editor-platform/collaboration-core';

export function ComponentUpdatePanel(props: {
  instanceId: string;
  content: NativeContent;
  catalog: TemplateCatalog;
  items: ComponentDefinition[];
  disabled: boolean;
  basis(): { state: Snapshot<NativeContent>; identity: Identity };
  onStage(prepared: PreparedApplication): Promise<void>;
  onClear(): void;
}) {
  const { instance, definition: old } = retainedComponent(props.content, props.instanceId);
  const latest = props.items.find(
    (d) => d.libraryId === old.libraryId && d.definitionId === old.definitionId,
  );
  const [targetHash, setTargetHash] = useState(latest?.hash ?? ''),
    [result, setResult] = useState<ComponentUpdatePreview>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<ComponentUpdateSelection>({
    instanceId: instance.id,
    choice: 'adopt',
  });
  const [selectedIds, setSelectedIds] = useState([instance.id]);
  const target = props.items.find((d) => d.hash === targetHash);
  const oldNative = reusablePrototype(old),
    newNative = target && reusablePrototype(target);
  const linked =
    'reuse' in props.content
      ? (props.content.reuse?.instances.filter(
          (i) => i.ref.libraryId === old.libraryId && i.ref.definitionId === old.definitionId,
        ) ?? [])
      : [];
  const clear = () => {
    props.onClear();
    setResult(undefined);
    setError('');
  };
  const mapping = (
    key: 'partMapping' | 'slotMapping' | 'inputMapping',
    from: { id: string; label?: string }[],
    to: { id: string; label?: string }[],
  ) => (
    <fieldset>
      <legend>
        {key === 'partMapping'
          ? '部品の対応先'
          : key === 'slotMapping'
            ? 'スロットの対応先'
            : '入力の対応先'}
      </legend>
      {from.map((old) => (
        <label key={old.id}>
          {old.label ?? old.id}
          <select
            value={selection[key]?.[old.id] ?? ''}
            onChange={(e) => {
              setSelection({
                ...selection,
                [key]: { ...selection[key], [old.id]: e.target.value || old.id },
              });
              clear();
            }}
          >
            <option value="">同じIDを使用</option>
            {to.map((next) => (
              <option key={next.id} value={next.id}>
                {next.label ?? next.id}
              </option>
            ))}
          </select>
        </label>
      ))}
    </fieldset>
  );
  return (
    <details>
      <summary>改訂の採用・部品の差し替え</summary>
      <p>
        現在: {old.name} v{old.version}。本文と上書きを保持して差分を確認します。
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        採用する公開版
        <select
          value={targetHash}
          onChange={(e) => {
            setTargetHash(e.target.value);
            clear();
          }}
        >
          <option value="">選択</option>
          {props.items.map((d) => (
            <option key={d.hash} value={d.hash}>
              {d.name} v{d.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        更新の扱い
        <select
          value={selection.choice}
          onChange={(e) => {
            setSelection({
              ...selection,
              choice: e.target.value as ComponentUpdateSelection['choice'],
            });
            clear();
          }}
        >
          <option value="adopt">選んだ版を採用</option>
          <option value="pin">現在の版を維持</option>
          <option value="detach">内容を保持してリンク解除</option>
        </select>
      </label>
      {linked.length > 1 && (
        <fieldset>
          <legend>この成果物で更新する部品</legend>
          {linked.map((i, index) => (
            <label key={i.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(i.id)}
                onChange={(e) => {
                  setSelectedIds(
                    e.target.checked
                      ? [...selectedIds, i.id]
                      : selectedIds.filter((id) => id !== i.id),
                  );
                  clear();
                }}
              />
              {old.name} {index + 1}（v{i.ref.version}）
            </label>
          ))}
        </fieldset>
      )}
      {target && (
        <details>
          <summary>対応先を明示して再確認</summary>
          {mapping('partMapping', old.payload.contract.parts, target.payload.contract.parts)}
          {mapping('slotMapping', old.payload.contract.slots, target.payload.contract.slots)}
          {mapping(
            'inputMapping',
            old.payload.contract.properties,
            target.payload.contract.properties,
          )}
          {isStructuredData(props.content) && (
            <DataMigrationForm
              old={old}
              next={target}
              current={props.content}
              selection={selection}
              onChange={(value) => {
                setSelection(value);
                clear();
              }}
            />
          )}
          {isWhiteboard(oldNative) &&
            newNative &&
            isWhiteboard(newNative) &&
            old.payload.contract.parts.map((part) => {
              const before = oldNative.nodes.find((n) => n.id === part.nativeId);
              const nextPart = target.payload.contract.parts.find(
                (p) => p.id === (selection.partMapping?.[part.id] ?? part.id),
              );
              const after = newNative.nodes.find((n) => n.id === nextPart?.nativeId);
              return before?.ports
                ?.filter((port) => !after?.ports?.some((p) => p.key === port.key))
                .map((port) => (
                  <label key={part.id + ':' + port.key}>
                    削除portの対応先: {port.label}
                    <select
                      value={selection.portMapping?.[part.id + ':' + port.key] ?? ''}
                      onChange={(e) => {
                        setSelection({
                          ...selection,
                          portMapping: {
                            ...selection.portMapping,
                            [part.id + ':' + port.key]: e.target.value,
                          },
                        });
                        clear();
                      }}
                    >
                      <option value="">保留・接続先を選択</option>
                      {['auto', 'top', 'right', 'bottom', 'left'].map((key) => (
                        <option key={key}>{key}</option>
                      ))}
                      {after?.ports?.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ));
            })}
          <label>
            新版でのバリエーション
            <select
              value={selection.variant ?? ''}
              onChange={(e) => {
                setSelection({ ...selection, variant: e.target.value || undefined });
                clear();
              }}
            >
              <option value="">現在のバリエーションを維持</option>
              {target.payload.contract.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        </details>
      )}
      <button
        disabled={props.disabled || busy || !target || !selectedIds.length}
        onClick={() => {
          void (async () => {
            if (!target) return;
            setBusy(true);
            clear();
            try {
              const value = await previewComponentUpdate({
                ...props.basis(),
                definition: target,
                closure: await props.catalog.closure(definitionRef(target)),
                swap:
                  target.libraryId !== old.libraryId || target.definitionId !== old.definitionId,
                selections: selectedIds.map((instanceId) => ({ ...selection, instanceId })),
              });
              setResult(value);
              if (value.prepared) await props.onStage(value.prepared);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        更新差分をプレビュー
      </button>
      {result && (
        <>
          <p role={result.conflicts.length ? 'alert' : 'status'}>
            {result.conflicts.length
              ? `${result.conflicts.length}件の競合があります。対応先を選び直すか、現在の版の維持・リンク解除を選んでください。`
              : selection.choice === 'pin'
                ? '現在の版を維持します。変更はありません。'
                : '更新可能です。差分と外観を確認して適用できます。'}
          </p>
          <ul>
            {result.changes.map((c, index) => (
              <li key={index}>
                {c.kind === 'update' ? '更新' : c.kind === 'preserve' ? '保持' : '競合'}: {c.field}{' '}
                — {c.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
