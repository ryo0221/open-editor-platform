import { useMemo, useState, type ReactNode } from 'react';
import { add, decimal, formatDecimal } from '@editor-platform/calculation-core';
export const formatAmount = (value: string) =>
  value.replace(
    /^(-?\d+)(\.\d+)?$/,
    (_, whole: string, fraction = '') => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction,
  );
/** Private view state only: IDs, stored order and calculations remain unchanged. */
export function EstimateBrowse<
  T extends { id: string; name: string; category?: string; cost?: string },
>(props: { label: string; items: T[]; children(items: T[]): ReactNode }) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [page, setPage] = useState(0),
    [order, setOrder] = useState('input');
  const items = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const found = props.items.filter(
      (item) =>
        (!category || item.category === category) &&
        words.every((word) =>
          `${item.id} ${item.name} ${item.category ?? ''}`.toLocaleLowerCase().includes(word),
        ),
    );
    return order === 'name'
      ? [...found].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
      : found;
  }, [props.items, query, category, order]);
  const categories = [...new Set(props.items.flatMap((i) => (i.category ? [i.category] : [])))];
  const last = Math.max(0, Math.ceil(items.length / 25) - 1),
    current = Math.min(page, last);
  const sum =
    items.length > 0 && items.every((i) => i.cost !== undefined)
      ? formatDecimal(items.reduce((total, i) => add(total, decimal(i.cost!)), decimal('0')))
      : null;
  return (
    <div className="estimate-browser">
      <div className="estimate-browse-controls">
        <label>
          {props.label}を検索
          <input
            type="search"
            value={query}
            placeholder="名称・ID（空白で絞り込み）"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        {categories.length > 0 && (
          <label>
            {props.label}の区分
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(0);
              }}
            >
              <option value="">全区分</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          {props.label}の表示順
          <select
            value={order}
            onChange={(e) => {
              setOrder(e.target.value);
              setPage(0);
            }}
          >
            <option value="input">登録順</option>
            <option value="name">名称順（数字順）</option>
          </select>
        </label>
      </div>
      <p>
        {items.length} / {props.items.length}件 · {items.length ? current * 25 + 1 : 0}〜
        {Math.min((current + 1) * 25, items.length)}件を表示
        {sum !== null && ` · 絞込小計 ${formatAmount(sum)}（調整を含まない）`}
      </p>
      {props.children(items.slice(current * 25, (current + 1) * 25))}
      {last > 0 && (
        <nav aria-label={`${props.label}のページ`}>
          <button disabled={current === 0} onClick={() => setPage(current - 1)}>
            前の25件
          </button>
          <span>
            {current + 1} / {last + 1}
          </span>
          <button disabled={current === last} onClick={() => setPage(current + 1)}>
            次の25件
          </button>
          <button disabled={current === last} onClick={() => setPage(last)}>
            最後のページ
          </button>
        </nav>
      )}
    </div>
  );
}
