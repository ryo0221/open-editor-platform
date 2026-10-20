import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorInputsContext, Menu, Section } from '@editor-platform/editor-ui';
import {
  EmbeddedReference,
  ReferenceItem,
  ReferenceOption,
  ReferenceResolver,
  ReferenceState,
  referenceKey,
} from './index';

export interface ReferenceSurfaceProps {
  references?: ReferenceResolver;
  focusReferenceId?: string;
}
export function useReferenceItems<T extends ReferenceItem>(
  items: T[],
  resolver?: ReferenceResolver,
): T[] {
  const [, render] = useState(0);
  const refs = items.flatMap((i) => (i.reference ? [i.reference] : []));
  const key = canonicalJson(refs.map(referenceKey));
  const current = useRef(refs);
  current.current = refs;
  useEffect(() => resolver?.observe(current.current, () => render((n) => n + 1)), [resolver, key]);
  return items.map((item) => {
    if (!item.reference || !resolver) return item;
    const state = resolver.get(item.reference);
    return {
      ...item,
      src: state.projection?.src,
      imageFit: item.reference.fit === 'contain' ? 'fit' : 'fill',
    };
  });
}
export function ReferenceTools({
  resolver,
  readOnly,
  insert,
  label = '参照を埋め込む',
  identity,
}: {
  resolver?: ReferenceResolver;
  readOnly?: boolean;
  label?: string;
  identity?: string;
  insert(reference: EmbeddedReference, src: string, label: string): void;
}) {
  const inputs = useContext(EditorInputsContext);
  const scope = useMemo(() => ({ resolver }), [resolver]);
  const empty = { scope, options: [] as ReferenceOption[], source: '', error: '', busy: false };
  const [discovery, setDiscovery] = useState(empty);
  // Mask the old scope synchronously, before effects or pending list responses.
  const { options, source, error, busy } = discovery.scope === scope ? discovery : empty;
  const [mode, setMode] = useState<EmbeddedReference['mode']>('fixed');
  const alive = useRef(true),
    latest = useRef({ readOnly, scope, identity, insert }),
    request = useRef(0);
  latest.current = { readOnly, scope, identity, insert };
  const current = () => alive.current && latest.current.scope === scope;
  const update = (patch: Partial<typeof empty>) => {
    if (current())
      setDiscovery((previous) => ({ ...(previous.scope === scope ? previous : empty), ...patch }));
  };
  useEffect(() => {
    setDiscovery({ scope, options: [], source: '', error: '', busy: false });
  }, [scope]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!resolver) return null;
  async function discover() {
    if (busy) return;
    const generation = ++request.current;
    try {
      const values = await resolver!.host.list();
      if (current() && generation === request.current) {
        update({
          options: values,
          source: values.length ? '0' : '',
          error: values.length
            ? ''
            : '保存済みのData／Graph／Geoがありません。元を保存してから再取得してください。',
        });
      }
    } catch (e) {
      if (generation === request.current) update({ error: String(e) });
    }
  }
  async function create() {
    if (readOnly || busy || !options[Number(source)]) return;
    try {
      inputs?.flush();
      // A pending discovery must not replace the choices of this creation.
      request.current++;
      update({ busy: true, error: '' });
      const ref = await resolver!.create(options[Number(source)].source, mode);
      if (!current() || latest.current.readOnly) return;
      if (latest.current.identity !== identity)
        throw new Error('配置先の選択が変わりました。再度配置してください。');
      if (inputs?.getSnapshot().dirty || inputs?.getSnapshot().composing)
        throw new Error('入力が変わりました。確定してから再度配置してください。');
      const projection = resolver!.project(ref.snapshot, ref.source.target);
      latest.current.insert(ref, projection.src, projection.label);
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      update({ busy: false });
    }
  }
  return (
    <Menu label={label} onOpen={() => void discover()}>
      <button type="button" disabled={busy} onClick={() => void discover()}>
        参照元を再取得
      </button>
      <label className="ep-field">
        参照元
        <select
          aria-label="埋め込みの参照元"
          disabled={busy}
          value={source}
          onChange={(e) => update({ source: e.target.value })}
        >
          <option value="" disabled>
            保存済みの参照元を選択
          </option>
          {options.map((option, i) => (
            <option key={i} value={String(i)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ep-field">
        更新方式
        <select
          aria-label="埋め込みの更新方式"
          disabled={busy}
          value={mode}
          onChange={(e) => setMode(e.target.value as EmbeddedReference['mode'])}
        >
          <option value="fixed">固定版</option>
          <option value="follow">更新連動（保存済みの変更）</option>
        </select>
      </label>
      <button
        type="button"
        disabled={readOnly || busy || source === ''}
        onClick={() => void create()}
      >
        参照を配置
      </button>
      {error && <p role="alert">{error}</p>}
    </Menu>
  );
}
const statusLabels: Record<ReferenceState['status'], string> = {
  loading: '取得中',
  ready: '解決済み',
  'missing-source': '参照元が見つかりません',
  'missing-target': 'view／列／nodeが削除されました',
  forbidden: '参照権限がありません',
  offline: 'オフライン：保持した固定表示',
  stale: '古い応答／キャッシュ',
  unsupported: '未対応の参照',
  error: '参照の解決に失敗しました',
};
export function ReferenceInspector({
  item,
  pageId,
  fitSupported = true,
  resolver,
  readOnly,
  patch,
}: {
  item?: ReferenceItem;
  pageId?: string;
  fitSupported?: boolean;
  resolver?: ReferenceResolver;
  readOnly?: boolean;
  patch(patch: Partial<ReferenceItem>): void;
}) {
  const inputs = useContext(EditorInputsContext),
    [error, setError] = useState('');
  const [, render] = useState(0);
  useEffect(() => resolver?.subscribe(() => render((n) => n + 1)), [resolver]);
  if (!item?.reference) return null;
  const reference = item.reference,
    state = resolver?.get(reference),
    snapshot = state?.snapshot ?? reference.snapshot;
  const change = (next: EmbeddedReference) => {
    inputs?.flush();
    patch({
      reference: next,
      src: resolver?.project(next.snapshot, next.source.target).src ?? item.src,
    });
  };
  const act = (fn: () => void | Promise<void>) => {
    try {
      inputs?.flush();
      Promise.resolve(fn()).catch((e) => setError(String(e)));
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Section title="参照埋め込み">
      <p role="status">
        {state ? statusLabels[state.status] : '保持した固定表示（Host未接続）'} ·{' '}
        {reference.mode === 'follow' ? '更新連動' : '固定版'}
      </p>
      {state?.message && <p>{state.message}</p>}
      <p>
        元の版: {snapshot.versionId}
        <br />
        SHA-256: <code>{snapshot.contentHash}</code>
      </p>
      <button
        type="button"
        disabled={!resolver?.host.open}
        onClick={() => act(() => resolver!.host.open!(reference.source, item.id, pageId))}
      >
        元を編集
      </button>
      <button
        type="button"
        disabled={!resolver}
        onClick={() =>
          act(async () => {
            await resolver!.refresh(reference);
          })
        }
      >
        参照を再取得
      </button>
      <ReferenceTools
        resolver={resolver}
        readOnly={readOnly}
        label="参照先を変更"
        identity={item.id}
        insert={(reference, src) => patch({ reference, src })}
      />
      <label className="ep-field">
        更新方式
        <select
          aria-label="参照の更新方式"
          disabled={readOnly}
          value={reference.mode}
          onChange={(e) =>
            act(() =>
              change({ ...reference, mode: e.target.value as EmbeddedReference['mode'], snapshot }),
            )
          }
        >
          <option value="fixed">固定版</option>
          <option value="follow">更新連動（保存済みの変更）</option>
        </select>
      </label>
      {fitSupported ? (
        <label className="ep-field">
          表示方法
          <select
            aria-label="参照の表示方法"
            disabled={readOnly}
            value={reference.fit}
            onChange={(e) =>
              act(() => change({ ...reference, fit: e.target.value as EmbeddedReference['fit'] }))
            }
          >
            <option value="contain">全体を表示</option>
            <option value="cover">領域を埋める</option>
          </select>
        </label>
      ) : (
        <p>画像は元の縦横比を保って表示します。幅を調整できます。</p>
      )}
      <button
        type="button"
        disabled={readOnly || !state?.projection}
        onClick={() =>
          act(() =>
            patch({
              reference: { ...reference, mode: 'fixed', snapshot },
              src: state!.projection!.src,
            }),
          )
        }
      >
        現在の版を固定
      </button>
      <button
        type="button"
        disabled={readOnly || !state?.projection}
        onClick={() => act(() => patch({ reference: undefined, src: state!.projection!.src }))}
      >
        参照を解除して画像にする
      </button>
      {error && <p role="alert">{error}</p>}
    </Section>
  );
}

/** Atomic Document node views can subscribe without changing ProseMirror content/history. */
export function ReferenceImage({
  item,
  resolver,
  width,
}: {
  item: ReferenceItem & { alt?: string };
  resolver?: ReferenceResolver;
  width?: number;
}) {
  const [projected] = useReferenceItems([item], resolver);
  const state = item.reference && resolver?.get(item.reference);
  return (
    <>
      <img
        src={projected.src}
        alt={item.alt ?? '参照埋め込み'}
        style={{ width: width ?? '100%', objectFit: item.reference?.fit }}
      />
      {state && state.status !== 'ready' && (
        <span role="status">
          {statusLabels[state.status]} {state.message}
        </span>
      )}
    </>
  );
}
export function ReferenceWarnings({
  items,
  resolver,
}: {
  items: ReferenceItem[];
  resolver?: ReferenceResolver;
}) {
  if (!resolver) return null;
  return (
    <>
      {items.flatMap((item) => {
        if (!item.reference) return [];
        const state = resolver.get(item.reference);
        return state.status === 'ready'
          ? []
          : [
              <p role="status" key={item.id}>
                {item.id}: {statusLabels[state.status]} {state.message}
              </p>,
            ];
      })}
    </>
  );
}
