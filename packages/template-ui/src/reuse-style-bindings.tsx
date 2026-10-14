import { useEffect, useState } from 'react';
import {
  definitionRef,
  refKey,
  type ComponentContract,
  type ReusableDefinition,
} from '@editor-platform/reuse-core';
import {
  reusableParts,
  type ReusablePayload,
  type TemplateCatalog,
  type Domain,
  type NativeContent,
} from '@editor-platform/templates';

export interface ComponentStyleSelection {
  styles: NonNullable<ReusablePayload['styles']>;
  dependencies: ReusableDefinition<unknown>[];
}
export function ComponentStyleBindings(props: {
  domain: Domain;
  contract: ComponentContract;
  content: NativeContent;
  catalog: TemplateCatalog;
  value: ComponentStyleSelection;
  onChange(value: ComponentStyleSelection): void;
  onWorking?(busy: boolean): void;
}) {
  const [items, setItems] = useState<ReusableDefinition<unknown>[]>([]),
    [error, setError] = useState('');
  const [part, setPart] = useState(props.contract.parts[0]?.id ?? ''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void props.catalog
      .listReusable({ kind: 'style', domain: props.domain })
      .then((values) => {
        if (!disposed) setItems(values);
      })
      .catch((error) => {
        if (!disposed) setError((error as Error).message);
      });
    return () => {
      disposed = true;
    };
  }, [props.catalog, props.domain]);
  const native = reusableParts(props.content);
  const choices = [
    ...new Map(
      [
        ...props.value.dependencies.filter((d) => d.kind === 'style' && d.domain === props.domain),
        ...items,
      ].map((d) => [refKey(d), d]),
    ).values(),
  ];
  const binding = props.value.styles.find((b) => b.partId === part);
  return (
    <fieldset disabled={busy}>
      <legend>部品にスタイルを割り当てる</legend>
      {error && <p role="alert">{error}</p>}
      <p>
        「トークン・スタイル」で公開した版を選びます。公開入力の既定値・variant・個別入力は、このスタイルより優先します。
      </p>
      <label>
        スタイルの対象
        <select value={part} onChange={(e) => setPart(e.target.value)}>
          {props.contract.parts.map((p) => (
            <option key={p.id} value={p.id}>
              {String(
                native.get(p.nativeId)?.name ?? native.get(p.nativeId)?.text ?? p.nativeId,
              ).slice(0, 40)}{' '}
              —{' '}
              {String(native.get(p.nativeId)?.type ?? native.get(p.nativeId)?.kind ?? 'container')}{' '}
              · {p.nativeId}
            </option>
          ))}
        </select>
      </label>
      <label>
        採用するスタイルの版
        <select
          value={binding ? refKey(binding.ref) : ''}
          onChange={(e) => {
            const key = e.target.value;
            const styles = props.value.styles.filter((b) => b.partId !== part);
            if (!key) {
              props.onChange({ ...props.value, styles });
              return;
            }
            const selected = choices.find((d) => refKey(d) === key)!;
            setBusy(true);
            props.onWorking?.(true);
            setError('');
            const retained = props.value.dependencies.some(
              (d) => refKey(d) === key && d.hash === selected.hash,
            );
            void (
              retained
                ? Promise.resolve(props.value.dependencies)
                : props.catalog.closure(definitionRef(selected)).then((c) => c.definitions)
            )
              .then((dependencies) => {
                const definitions = new Map<string, ReusableDefinition<unknown>>();
                for (const d of [...props.value.dependencies, ...dependencies]) {
                  const old = definitions.get(refKey(d));
                  if (old && old.hash !== d.hash)
                    throw new Error('同じ版のスタイル・トークンの内容が一致しません。');
                  definitions.set(refKey(d), d);
                }
                props.onChange({
                  styles: [...styles, { partId: part, ref: definitionRef(selected) }],
                  dependencies: [...definitions.values()],
                });
              })
              .catch((error) => setError((error as Error).message))
              .finally(() => {
                setBusy(false);
                props.onWorking?.(false);
              });
          }}
        >
          <option value="">固定したnative書式を使用</option>
          {choices.map((d) => (
            <option key={refKey(d)} value={refKey(d)}>
              {d.name} v{d.version}
            </option>
          ))}
        </select>
      </label>
      {props.value.styles.length > 0 && (
        <ul>
          {props.value.styles.map((b) => (
            <li key={b.partId}>
              {b.partId}:{' '}
              {choices.find((d) => refKey(d) === refKey(b.ref))?.name ?? b.ref.definitionId} v
              {b.ref.version}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
