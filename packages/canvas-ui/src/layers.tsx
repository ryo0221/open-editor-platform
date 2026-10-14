import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, Unlock, Layers } from 'lucide-react';
import { IconButton } from '@editor-platform/editor-ui';
export interface LayerEntry {
  id: string;
  parentId?: string;
  name: string;
  /** Full searchable body, independent of the displayed or explicitly assigned name. */
  text?: string;
  type: string;
  hidden?: boolean;
  locked?: boolean;
}
interface LayerNavigatorProps {
  entries: LayerEntry[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onReveal?: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onState: (id: string, patch: { hidden?: boolean; locked?: boolean }) => void;
  onReparent?: (id: string, parentId?: string) => void;
  onReorder?: (id: string, delta: number) => void;
  readOnly?: boolean;
}
export function LayerNavigator(props: LayerNavigatorProps) {
  // Geometry edits leave the layer list unchanged. Forward events to the latest
  // committed Host callbacks while allowing that unchanged list to skip rendering.
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const actions = useMemo(
    () => ({
      onSelect: (ids: string[]) => current.current.onSelect(ids),
      onReveal: (id: string) => current.current.onReveal?.(id),
      onRename: (id: string, name: string) => current.current.onRename(id, name),
      onState: (id: string, patch: { hidden?: boolean; locked?: boolean }) =>
        current.current.onState(id, patch),
      onReparent: (id: string, parentId?: string) => current.current.onReparent?.(id, parentId),
      onReorder: (id: string, delta: number) => current.current.onReorder?.(id, delta),
    }),
    [],
  );
  return (
    <LayerTree
      {...props}
      {...actions}
      onReveal={props.onReveal ? actions.onReveal : undefined}
      onReparent={props.onReparent ? actions.onReparent : undefined}
      onReorder={props.onReorder ? actions.onReorder : undefined}
    />
  );
}
const LayerTree = memo(
  function LayerTree({
    entries,
    selected,
    onSelect,
    onReveal,
    onRename,
    onState,
    onReparent,
    onReorder,
    readOnly = false,
  }: LayerNavigatorProps) {
    const [query, setQuery] = useState(''),
      [collapsed, setCollapsed] = useState<string[]>([]),
      [rename, setRename] = useState<string>();
    const dragged = useRef('');
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const depth = (entry: LayerEntry) => {
      let level = 0,
        parent = byId.get(entry.parentId ?? '');
      const seen = new Set<string>();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        level++;
        parent = byId.get(parent.parentId ?? '');
      }
      return level;
    };
    const childrenByParent = new Map<string | undefined, LayerEntry[]>();
    for (const entry of entries) {
      const parent = byId.has(entry.parentId ?? '') ? entry.parentId : undefined;
      const children = childrenByParent.get(parent) ?? [];
      children.push(entry);
      childrenByParent.set(parent, children);
    }
    const ordered: LayerEntry[] = [],
      visited = new Set<string>();
    const visit = (parent: string | undefined) => {
      for (const entry of childrenByParent.get(parent) ?? []) {
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
        ordered.push(entry);
        visit(entry.id);
      }
    };
    visit(undefined);
    const shown = ordered.filter((e) => {
      if (query)
        return `${e.name} ${e.type} ${e.text ?? ''}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase());
      let parent = e.parentId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        if (collapsed.includes(parent)) return false;
        seen.add(parent);
        parent = byId.get(parent)?.parentId;
      }
      return true;
    });
    return (
      <>
        <input
          className="layer-search"
          aria-label="Search layers"
          placeholder="Search layers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div role="tree" aria-label="Layers" className="layer-tree">
          {shown.map((e) => {
            const children = !!childrenByParent.get(e.id)?.length;
            return (
              <div
                key={e.id}
                role="treeitem"
                aria-selected={selected.includes(e.id)}
                aria-level={depth(e) + 1}
                aria-expanded={children ? !collapsed.includes(e.id) : undefined}
                draggable={!readOnly}
                onDragStart={() => {
                  dragged.current = e.id;
                }}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (dragged.current !== e.id) onReparent?.(dragged.current, e.id);
                }}
                style={{ paddingLeft: depth(e) * 12 }}
              >
                <button
                  className="layer-disclosure"
                  aria-label={`Expand ${e.name}`}
                  onClick={() =>
                    setCollapsed(
                      collapsed.includes(e.id)
                        ? collapsed.filter((id) => id !== e.id)
                        : [...collapsed, e.id],
                    )
                  }
                >
                  {children ? (
                    collapsed.includes(e.id) ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )
                  ) : (
                    <Layers size={13} />
                  )}
                </button>
                {rename === e.id ? (
                  <input
                    autoFocus
                    aria-label="Rename layer"
                    defaultValue={e.name}
                    onBlur={(ev) => {
                      onRename(e.id, ev.target.value);
                      setRename(undefined);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') ev.currentTarget.blur();
                      if (ev.key === 'Escape') setRename(undefined);
                    }}
                  />
                ) : (
                  <button
                    className="layer-name"
                    aria-label={`Layer ${e.name}`}
                    title={`${e.type}: ${e.name}`}
                    onClick={(ev) => {
                      onSelect(
                        ev.shiftKey
                          ? selected.includes(e.id)
                            ? selected.filter((id) => id !== e.id)
                            : [...selected, e.id]
                          : [e.id],
                      );
                      if (query && !ev.shiftKey) onReveal?.(e.id);
                    }}
                    onDoubleClick={() => {
                      if (!readOnly) setRename(e.id);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'F2' && !readOnly) setRename(e.id);
                      if (ev.altKey && ['ArrowUp', 'ArrowDown'].includes(ev.key)) {
                        ev.preventDefault();
                        onReorder?.(e.id, ev.key === 'ArrowUp' ? -1 : 1);
                      }
                    }}
                  >
                    {e.name}
                    <small>{e.type}</small>
                  </button>
                )}
                <IconButton
                  icon={e.hidden ? EyeOff : Eye}
                  label={`${e.hidden ? 'Show' : 'Hide'} ${e.name}`}
                  disabled={readOnly}
                  onClick={() => onState(e.id, { hidden: !e.hidden })}
                />
                <IconButton
                  icon={e.locked ? Lock : Unlock}
                  label={`${e.locked ? 'Unlock' : 'Lock'} ${e.name}`}
                  disabled={readOnly}
                  onClick={() => onState(e.id, { locked: !e.locked })}
                />
              </div>
            );
          })}
        </div>
        {onReparent && (
          <button
            disabled={readOnly || !selected.length}
            onClick={() => selected.forEach((id) => onReparent(id, undefined))}
          >
            Move selection to root
          </button>
        )}
      </>
    );
  },
  (previous, next) =>
    previous.readOnly === next.readOnly &&
    previous.onSelect === next.onSelect &&
    previous.onReveal === next.onReveal &&
    previous.onRename === next.onRename &&
    previous.onState === next.onState &&
    previous.onReparent === next.onReparent &&
    previous.onReorder === next.onReorder &&
    previous.selected.length === next.selected.length &&
    previous.selected.every((id, i) => id === next.selected[i]) &&
    previous.entries.length === next.entries.length &&
    previous.entries.every((entry, i) => {
      const other = next.entries[i];
      return (
        entry.id === other.id &&
        entry.parentId === other.parentId &&
        entry.name === other.name &&
        entry.text === other.text &&
        entry.type === other.type &&
        entry.hidden === other.hidden &&
        entry.locked === other.locked
      );
    }),
);
