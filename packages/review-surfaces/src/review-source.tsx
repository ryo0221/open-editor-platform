import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ElementAddress } from '@editor-platform/editor-core';
import { Dialog } from '@editor-platform/editor-ui';
import type { ReviewResolvedSource } from './model';
import {
  isRetainedSource,
  regionLinesLabel,
  sourceExcerpt,
  type ResolvedReviewSource,
} from './review-utils';

export function useRetainedSource(
  resolveAnnotationSource?: (address: ElementAddress) => Promise<ReviewResolvedSource | undefined>,
) {
  const [notice, setNotice] = useState('');
  const [resolved, setResolved] = useState<ResolvedReviewSource>();
  const target = useRef<HTMLElement | null>(null);
  const excerpt = useMemo(() => sourceExcerpt(resolved), [resolved]);
  useEffect(() => {
    target.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [resolved]);
  const sequence = useRef(0);
  function invalidate() {
    setNotice('');
    sequence.current++;
    setResolved(undefined);
  }
  async function open(address: ElementAddress, current: boolean, focusCurrent: () => void) {
    const requested = ++sequence.current;
    setResolved(undefined);
    setNotice('');
    if (current) {
      focusCurrent();
      return;
    }
    try {
      const source = await resolveAnnotationSource?.(address);
      if (requested !== sequence.current) return;
      if (isRetainedSource(source, address)) {
        setResolved({ source, address });
      } else
        setNotice(
          'この注釈の旧原本版をHostから取得できません。現在の対象行を選び、明示的に再紐付けしてください。',
        );
    } catch {
      if (requested === sequence.current)
        setNotice(
          '旧原本版の取得に失敗しました。再試行、または現在の行への再紐付けを選んでください。',
        );
    }
  }
  return {
    notice,
    resolved,
    excerpt,
    target,
    invalidate,
    open,
    close: () => setResolved(undefined),
  };
}

export function SourceVersionDialog({
  resolved,
  excerpt,
  targetRef,
  onClose,
}: {
  resolved: ResolvedReviewSource;
  excerpt: ReturnType<typeof sourceExcerpt>;
  targetRef: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  return (
    <Dialog title="Annotation source version" onClose={onClose}>
      <p>
        {resolved.source.name} · {resolved.source.side}
        {' · source'} {resolved.source.revisionId}
        {' · lines'} {regionLinesLabel(resolved.address)}
      </p>
      <pre className="ep-review-retained-source">
        {excerpt?.before}
        <mark ref={targetRef}>{excerpt?.selected}</mark>
        {excerpt?.after}
      </pre>
    </Dialog>
  );
}
