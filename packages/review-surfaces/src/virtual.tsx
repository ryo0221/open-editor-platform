import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** Variable measured rows: long wrapped lines remain scrollable without a full-file DOM. */
export function VirtualRows<T>({
  rows,
  rowKey,
  render,
  label,
  focusIndex,
  estimate = 30,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  render: (row: T, index: number) => ReactNode;
  label: string;
  focusIndex?: number;
  estimate?: number;
}) {
  const scroll = useRef<HTMLDivElement>(null),
    sizes = useRef(new Map<string, number>());
  const [top, setTop] = useState(0),
    [height, setHeight] = useState(700),
    [revision, setRevision] = useState(0);
  const offsets = useMemo(() => {
    const result = [0];
    for (const row of rows)
      result.push(result.at(-1)! + (sizes.current.get(rowKey(row)) ?? estimate));
    return result;
  }, [rows, rowKey, estimate, revision]);
  const indexAt = (offset: number) => {
    let l = 0,
      r = rows.length;
    while (l < r) {
      const m = (l + r) >> 1;
      if (offsets[m + 1] < offset) l = m + 1;
      else r = m;
    }
    return l;
  };
  const start = Math.max(0, indexAt(Math.min(top, offsets.at(-1)!)) - 8),
    end = Math.min(rows.length, indexAt(top + height) + 10);
  useEffect(() => {
    const el = scroll.current!;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vrow!,
          h = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        if (h > 0 && sizes.current.get(key) !== h) {
          sizes.current.set(key, h);
          changed = true;
        }
      }
      if (changed) setRevision((n) => n + 1);
    });
    scroll.current!.querySelectorAll('[data-vrow]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [start, end, rows]);
  useEffect(() => {
    if (focusIndex === undefined || !rows[focusIndex]) return;
    const offset = offsets[focusIndex];
    scroll.current!.scrollTop = Math.max(0, offset - 90);
    setTop(scroll.current!.scrollTop);
    // A requested row changes scroll once; later row measurements preserve reading position.
  }, [focusIndex, rows]);
  return (
    <div
      ref={scroll}
      className="ep-file-lines"
      role="region"
      aria-label={label}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: offsets[start] }} aria-hidden />
      {rows.slice(start, end).map((row, i) => (
        <div key={rowKey(row)} data-vrow={rowKey(row)}>
          {render(row, i + start)}
        </div>
      ))}
      <div style={{ height: Math.max(0, offsets.at(-1)! - offsets[end]) }} aria-hidden />
    </div>
  );
}
