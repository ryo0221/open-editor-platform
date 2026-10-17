import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LayerEntry } from './layers';

const rowHeight = 36;
const overscan = 4;

/** Rendering only: search, hierarchy and selection still receive the complete list. */
export function LayerWindow({
  entries,
  selected,
  editing,
  dragging,
  virtualize,
  query,
  children,
}: {
  entries: LayerEntry[];
  selected: string[];
  editing?: string;
  dragging?: string;
  virtualize?: boolean;
  query: string;
  children: (entry: LayerEntry) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const [focused, setFocused] = useState<string>();
  const [pendingFocus, setPendingFocus] = useState<string>();
  const windowed = !!virtualize && entries.length > 200;
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan);
  const end = Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan;
  const scrollTo = (index: number) => {
    const node = root.current;
    if (!node || !windowed || node.clientHeight <= 0) return;
    const top = index * rowHeight;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + rowHeight > node.scrollTop + node.clientHeight)
      node.scrollTop = top + rowHeight - node.clientHeight;
    setViewport({ top: node.scrollTop, height: node.clientHeight });
  };
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !windowed) return;
    const observer = new ResizeObserver(() =>
      setViewport({ top: node.scrollTop, height: node.clientHeight }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [windowed]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    node.scrollTop = 0;
    setViewport({ top: 0, height: node.clientHeight });
    if (!query) {
      const index = entries.findIndex((entry) => entry.id === selected.at(-1));
      if (index >= 0) scrollTo(index);
    }
  }, [query]);
  useLayoutEffect(() => {
    const index = entries.findIndex((entry) => entry.id === selected.at(-1));
    if (index >= 0) scrollTo(index);
  }, [selected, viewport.height, windowed]);
  useLayoutEffect(() => {
    // A search/collapse can shorten the logical list before the scroll event fires.
    const node = root.current;
    if (node && windowed && node.scrollTop !== viewport.top)
      setViewport({ top: node.scrollTop, height: node.clientHeight });
  }, [entries.length, windowed]);
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    const item = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[data-layer-id]') ?? [],
    ).find((node) => node.dataset.layerId === pendingFocus);
    item?.querySelector<HTMLButtonElement>('.layer-name')?.focus();
    setPendingFocus(undefined);
  }, [pendingFocus]);
  return (
    <div
      ref={root}
      role="tree"
      aria-label="Layers"
      className={`layer-tree${windowed ? ' layer-tree-windowed' : ''}`}
      onScroll={(event) => {
        if (windowed)
          setViewport({
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          });
      }}
      onFocusCapture={(event) =>
        setFocused(
          (event.target as Element).closest<HTMLElement>('[data-layer-id]')?.dataset.layerId,
        )
      }
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
      }}
      onKeyDown={(event) => {
        if (
          !windowed ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          !(event.target as Element).matches('.layer-name') ||
          !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
        )
          return;
        event.preventDefault();
        const index = entries.findIndex((entry) => entry.id === focused);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? entries.length - 1
              : Math.max(
                  0,
                  Math.min(entries.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)),
                );
        scrollTo(next);
        setPendingFocus(entries[next]?.id);
      }}
    >
      <div
        style={windowed ? { height: entries.length * rowHeight, position: 'relative' } : undefined}
      >
        {entries.flatMap((entry, index) =>
          !windowed ||
          (index >= start && index < end) ||
          entry.id === editing ||
          entry.id === dragging ||
          entry.id === focused ||
          entry.id === pendingFocus
            ? [
                <div
                  key={entry.id}
                  style={
                    windowed
                      ? { position: 'absolute', top: index * rowHeight, left: 0, right: 0 }
                      : undefined
                  }
                >
                  {children(entry)}
                </div>,
              ]
            : [],
        )}
      </div>
    </div>
  );
}
