import { useEffect, useRef, useState } from 'react';
import { useEditorInput } from '@editor-platform/editor-ui';
import {
  previewFictionMapChange,
  prepareFictionMapImport,
  fictionMapLimits,
  type FictionMapContent,
  type PreparedFictionMapChange,
} from './model';
import { renderFictionMapSvg } from './render';
import type { ComponentProps } from 'react';
import type { FictionMapSavedViews } from './saved-views';

/** Explicit, previewed native replacement in the current Artifact and its existing history.
 * Candidate production stays outside the Editor; importing does not interpret prompts or World data.
 */
export function FictionMapNativeInput({
  base,
  readOnly,
  onCommit,
  onError,
}: ComponentProps<typeof FictionMapSavedViews>) {
  const [candidate, setCandidate] = useState<{
    content: FictionMapContent;
    prepared: PreparedFictionMapChange;
    generation: number;
    svg: string;
    name: string;
    revision: typeof base.revision;
  }>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    generation = useRef(0),
    alive = useRef(true),
    input = useRef<HTMLInputElement>(null),
    latest = useRef({ base, readOnly, onCommit, onError });
  latest.current = { base, readOnly, onCommit, onError };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const inputs = useEditorInput({
    label: 'Fiction Map refinement candidate',
    read: () => ({ dirty: pending.current }),
    prepare() {
      throw Error('Apply or cancel the map refinement candidate.');
    },
    focus() {
      input.current?.focus();
    },
  });
  function cancel() {
    generation.current++;
    pending.current = false;
    setCandidate(undefined);
    setBusy(false);
    if (input.current) input.current.value = '';
    inputs?.changed();
  }
  async function load(file: File) {
    if (readOnly) return;
    const other = inputs?.getSnapshot();
    if (other && (other.dirty > Number(pending.current) || other.composing || other.settling)) {
      onError('Apply or cancel other map inputs before loading a refinement.');
      return;
    }
    const request = ++generation.current;
    pending.current = true;
    setBusy(true);
    setCandidate(undefined);
    inputs?.changed();
    try {
      if (file.size > fictionMapLimits.inputBytes) throw Error('input-byte-limit');
      const text = await file.text();
      if (!alive.current || generation.current !== request) return;
      const current = latest.current;
      if (current.readOnly) throw Error('permission-denied');
      if (
        current.base.revision.sessionId !== base.revision.sessionId ||
        current.base.revision.sequence !== base.revision.sequence
      )
        throw Error('stale-revision');
      const prepared = prepareFictionMapImport(base, text, { mode: 'replace' });
      if (!prepared.ok) throw Error(`${prepared.diagnostic.code} ${prepared.diagnostic.path}`);
      const parsed = previewFictionMapChange(prepared.value);
      if (!parsed.ok) throw Error(parsed.diagnostic.code);
      const image = renderFictionMapSvg(parsed.value, { width: 800, height: 520 });
      setCandidate({
        content: parsed.value,
        prepared: prepared.value,
        generation: request,
        svg: image.svg,
        name: file.name,
        revision: base.revision,
      });
    } catch (error) {
      if (alive.current && generation.current === request) {
        pending.current = false;
        setCandidate(undefined);
        if (input.current) input.current.value = '';
        onError(String(error instanceof Error ? error.message : error));
        inputs?.changed();
      }
    } finally {
      if (alive.current && generation.current === request) setBusy(false);
    }
  }
  function apply() {
    if (
      !candidate ||
      busy ||
      latest.current.readOnly ||
      candidate.generation !== generation.current ||
      !pending.current
    )
      return;
    const other = inputs?.getSnapshot();
    if (other && (other.dirty > 1 || other.composing || other.settling)) {
      onError('Apply or cancel other map inputs before applying a refinement.');
      return;
    }
    try {
      const committed = latest.current.onCommit(candidate.prepared);
      if (!committed.ok) {
        onError(committed.diagnostic.code);
        return;
      }
      cancel();
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }
  return (
    <details className="fm-native-input">
      <summary>地図を段階的に詳細化</summary>
      <p>
        地図native
        JSONの候補を検証・プレビューして、現在のArtifactへ明示適用します。既存地物は同じIDで引き継ぎ、変更は1回のUndoで戻せます。候補にない地物は削除されます。
      </p>
      <label>
        詳細化するnative JSON
        <input
          ref={input}
          aria-label="Refinement native JSON"
          type="file"
          accept="application/json,.json"
          disabled={readOnly || busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void load(file);
          }}
        />
      </label>
      {busy && <p role="status">候補を検証しています。</p>}
      {candidate && (
        <>
          <p role="status">
            {candidate.name}: {base.content.features.length} → {candidate.content.features.length}
            地物。適用前のプレビューです。
          </p>
          {(candidate.revision.sessionId !== base.revision.sessionId ||
            candidate.revision.sequence !== base.revision.sequence) && (
            <p role="alert">
              stale-revision: 元の地図が変更されました。候補を取消し、読み込み直してください。
            </p>
          )}
          <p>
            追加{' '}
            {
              candidate.content.features.filter(
                (f) => !base.content.features.some((old) => old.id === f.id),
              ).length
            }
            ・ 削除{' '}
            {
              base.content.features.filter(
                (f) => !candidate.content.features.some((next) => next.id === f.id),
              ).length
            }
            。 同じIDの地物は候補のgeometry/metadataへ置き換わります。
          </p>
          <img
            alt="Map refinement preview"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(candidate.svg)}`}
            style={{ maxWidth: '100%', maxHeight: 400 }}
          />
        </>
      )}
      <button type="button" disabled={readOnly || busy || !candidate} onClick={apply}>
        Apply map refinement
      </button>
      <button type="button" disabled={!pending.current} onClick={cancel}>
        Cancel map refinement
      </button>
    </details>
  );
}
