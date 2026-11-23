import { useEffect, useRef, useState } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  projectLiveFigure,
  type EmbeddedReference,
  type ReferenceProjection,
} from '@editor-platform/artifact-references';
import { detachSlideReference, replaceSlideImageReference, type SlideObject } from './model';
import type { SlideEditing } from './view-shared';

export function SharedReferenceActions({
  editing,
  object,
}: {
  editing: SlideEditing;
  object: SlideObject;
}) {
  const { slide, references, liveReferences, readOnly } = editing;
  const [latest, setLatest] = useState<EmbeddedReference>();
  const [comparison, setComparison] = useState<{
    before: ReferenceProjection;
    after: ReferenceProjection;
    version: string;
  }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The parent keys this selection by the native reference, so peer geometry changes keep the comparison open.
  const { reference, liveQuote } = useRef(object).current;
  const active = useRef(true);
  const current = useRef(editing);
  current.current = editing;
  useEffect(() => {
    active.current = true;
    if (!reference || !references)
      return () => {
        active.current = false;
      };
    let request = 0;
    const observe = async () => {
      const checking = ++request;
      try {
        const result = await references.create(reference.source, reference.mode);
        if (active.current && checking === request) {
          setLatest(result.snapshot.revision > reference.snapshot.revision ? result : undefined);
        }
      } catch {
        if (active.current && checking === request) {
          setLatest(undefined);
          setComparison(undefined);
        }
      }
    };
    const stop = references.host.subscribe((id) => {
      if (id === reference.source.artifactId) void observe();
    });
    void observe();
    return () => {
      active.current = false;
      stop();
    };
  }, [reference, references]);

  if (!slide || (!reference && !liveQuote)) return null;
  const pageId = slide.id;

  async function detach() {
    setBusy(true);
    setError('');
    try {
      const expected = liveQuote ?? reference!;
      let src: string | undefined;
      if (liveQuote?.presentation.kind === 'figure' && liveReferences)
        src = await projectLiveFigure(
          liveQuote,
          liveReferences.provider,
          liveReferences.destinationArtifactId,
        );
      else if (reference && references) src = (await references.refresh(reference)).projection?.src;
      if (active.current && !current.current.readOnly)
        current.current.apply(detachSlideReference(pageId, object.id, expected, src));
    } catch (error) {
      if (active.current) setError(String(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function compare() {
    if (!references || !reference || !latest) return;
    setBusy(true);
    setError('');
    try {
      const before = (await references.refresh(reference)).projection;
      const verified = await references.create(latest.source, latest.mode);
      if (!before || canonicalJson(latest) !== canonicalJson(verified))
        throw Error('参照元の版が変わりました。もう一度確認してください。');
      if (active.current)
        setComparison({
          before,
          after: references.project(verified.snapshot, verified.source.target),
          version: canonicalJson(verified),
        });
    } catch (error) {
      if (active.current) setError(String(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <div className="ep-live-actions" aria-label="選択した引用の操作">
      {latest && (
        <button type="button" disabled={busy} onClick={() => void compare()}>
          画像引用の新版と比較
        </button>
      )}
      {comparison && reference && latest && comparison.version === canonicalJson(latest) && (
        <div className="ep-live-compare">
          <figure>
            <img src={comparison.before.src} alt={comparison.before.label} />
            <figcaption>採用済み {reference.snapshot.versionId}</figcaption>
          </figure>
          <figure>
            <img src={comparison.after.src} alt={comparison.after.label} />
            <figcaption>新版 {latest.snapshot.versionId}</figcaption>
          </figure>
          <button
            type="button"
            disabled={readOnly || busy}
            onClick={() =>
              editing.apply(
                replaceSlideImageReference(
                  pageId,
                  object.id,
                  reference,
                  latest,
                  comparison.after.src,
                  comparison.after.label,
                ),
              )
            }
          >
            画像引用を新版へ更新
          </button>
          <button type="button" onClick={() => setComparison(undefined)}>
            比較を閉じる
          </button>
        </div>
      )}
      <button
        type="button"
        disabled={
          readOnly ||
          busy ||
          (!!reference && !references) ||
          (liveQuote?.presentation.kind === 'figure' && !liveReferences)
        }
        onClick={() => void detach()}
      >
        {object.type === 'text' ? '値を残して引用を解除' : '画像を残して引用を解除'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
