import { useWording } from '@editor-platform/editor-ui';
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
  const t = useWording();
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
        <strong>{t(mode === 'spread' ? '見開き · 編集中の原稿' : '通読 · 編集中の原稿')}</strong>
        <button onClick={close}>{t('通読を閉じる')}</button>
      </header>
      <p>
        {t(
          content.pagination?.direction === 'rtl'
            ? '読み方向: 右から左。出力には保存した版を選択してください。'
            : '読み方向: 左から右。出力には保存した版を選択してください。',
        )}
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
            label={t('見開き {0}', i + 1)}
          />
        );
      })}
    </div>
  );
}
