import type { DesignContent } from './model';
import { DesignPageComparison } from './page-comparison';

export function MangaReading({
  content,
  mode,
  pageId,
  close,
}: {
  content: DesignContent;
  mode: 'spread' | 'all';
  pageId: string;
  close: () => void;
}) {
  const pages = content.pagination?.pages ?? [];
  const start = Math.max(
    0,
    pages.findIndex((p) => p.frameId === pageId),
  );
  const selected = mode === 'spread' ? pages.slice(start, start + 2) : pages;
  const pairs = Array.from({ length: Math.ceil(selected.length / 2) }, (_, i) =>
    selected.slice(i * 2, i * 2 + 2).map((p) => p.frameId),
  );
  return (
    <div className="manga-reading" role="region" aria-label="漫画の通読">
      <header>
        <strong>{mode === 'spread' ? '見開き' : '通読'} · 編集中の原稿</strong>
        <button onClick={close}>通読を閉じる</button>
      </header>
      <p>
        読み方向: {content.pagination?.direction === 'rtl' ? '右から左' : '左から右'}
        。出力には保存した版を選択してください。
      </p>
      {pairs.map((ids, i) => {
        const pair =
          content.pagination?.direction === 'rtl' ? [ids[1] ?? '', ids[0]] : [ids[0], ids[1] ?? ''];
        return (
          <DesignPageComparison
            key={i}
            content={content}
            leftId={pair[0]}
            rightId={pair[1]}
            label={`見開き ${i + 1}`}
          />
        );
      })}
    </div>
  );
}
