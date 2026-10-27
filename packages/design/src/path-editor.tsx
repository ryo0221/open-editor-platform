import { useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorInputsContext, CommitInput } from '@editor-platform/editor-ui';
import {
  PathHandles,
  type PathHandle,
  type PathHandleLine,
} from '@editor-platform/canvas-ui/path-handles';
import type { Drawing, EditorCommand } from '@editor-platform/editor-core';
import type { DesignContent, DesignElement, DesignDrawing } from './model';
import { designPathPoint, projectDesignPath, type DesignEditablePath } from './path';
import {
  moveDesignPathPoint,
  replaceDesignPath,
  setDesignAnchorMode,
  type DesignPathPointId,
} from './path-commands';

const pointKey = (subpath: string, id: string, side?: 'c1' | 'c2') =>
  JSON.stringify(side ? ['control', subpath, id, side] : ['anchor', subpath, id]);

export function useDesignPathEditor(options: {
  content: DesignContent;
  element?: DesignElement;
  readOnly: boolean;
  zoom: number;
  project(e: DesignElement): DesignDrawing[];
  apply(c: EditorCommand<DesignContent>): boolean;
  error(message: string): void;
  fit?(): boolean;
}) {
  const [active, setActive] = useState<string>(),
    [selected, setSelected] = useState<string>(),
    [preview, setPreview] = useState<DesignEditablePath>();
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<
    { base: DesignContent; path: DesignEditablePath; drawing: Drawing; id: string } | undefined
  >(undefined);
  const inputs = useContext(EditorInputsContext);
  const cancel = () => {
    gesture.current = undefined;
    setPreview(undefined);
    inputs?.changed();
  };
  const element = options.element,
    editing = !!element?.path && element.id === active;
  useEffect(() => {
    cancel();
  }, [options.content, options.readOnly, active, options.zoom]);
  useEffect(
    () =>
      inputs?.register({
        label: 'Path gesture',
        read: () => ({ dirty: !!gesture.current }),
        prepare: () => {
          throw Error('Finish or cancel the path gesture before saving/exporting');
        },
        focus: () => {},
        history: () => {
          if (!gesture.current) return false;
          cancel();
          return true;
        },
      }),
    [inputs],
  );
  const drawing = editing ? options.project(element!)[0] : undefined;
  const path = preview ?? element?.path;
  const points: PathHandle[] = [],
    lines: PathHandleLine[] = [],
    addresses = new Map<string, DesignPathPointId>();
  if (editing && path && drawing)
    for (const [si, s] of path.subpaths.entries()) {
      const add = (
        id: string,
        p: { x: number; y: number },
        kind: 'anchor' | 'control',
        label: string,
        address: DesignPathPointId,
      ) => {
        const w = designPathPoint(path, drawing, p);
        points.push({ id, ...w, kind, label });
        addresses.set(id, address);
      };
      for (const [i, a] of s.anchors.entries())
        add(pointKey(s.id, a.id), a, 'anchor', `Anchor ${si + 1}.${i + 1}`, {
          subpathId: s.id,
          anchorId: a.id,
        });
      for (const [i, e] of s.segments.entries())
        if (e.type === 'cubic')
          for (const side of ['c1', 'c2'] as const) {
            const a = s.anchors.find((a) => a.id === (side === 'c1' ? e.from : e.to))!;
            add(
              pointKey(s.id, e.id, side),
              e[side],
              'control',
              `Handle ${si + 1}.${i + 1}.${side}`,
              {
                subpathId: s.id,
                segmentId: e.id,
                side,
              },
            );
            lines.push({
              from: designPathPoint(path, drawing, a),
              to: designPathPoint(path, drawing, e[side]),
            });
          }
    }
  const address = selected ? addresses.get(selected) : undefined;
  const sub = path?.subpaths.find((s) => s.id === address?.subpathId);
  const local =
    address && sub
      ? 'anchorId' in address
        ? sub.anchors.find((a) => a.id === address.anchorId)
        : (() => {
            const e = sub.segments.find((e) => e.id === address.segmentId);
            return e?.type === 'cubic' ? e[address.side] : undefined;
          })()
      : undefined;
  function selectPoint(id: string) {
    if (gesture.current) return gesture.current.id === id;
    try {
      // Settle the old point's coordinate drafts before giving another point
      // ownership. Rejected drafts stay mounted and retain their original key.
      flushSync(() => {
        inputs?.flush();
        setSelected(id);
      });
      return true;
    } catch (e) {
      options.error((e as Error).message);
      return false;
    }
  }
  function settle() {
    cancel();
    try {
      inputs?.flush();
      return true;
    } catch (e) {
      options.error((e as Error).message);
      return false;
    }
  }
  function commit(next: DesignEditablePath, base = options.content) {
    if (!element?.path) return false;
    if (canonicalJson(next) === canonicalJson(element.path)) return true;
    return options.apply(replaceDesignPath(base, element.id, next, () => !latest.current.readOnly));
  }
  function keyDown(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (settle()) setActive(undefined);
      return;
    }
    if (['Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      options.error('Point deletion is not supported. Finish point editing to delete the object.');
      return;
    }
    if (!options.readOnly && address && local && path && event.key.startsWith('Arrow')) {
      event.preventDefault();
      event.stopPropagation();
      const amount = event.shiftKey ? 10 : 1;
      try {
        commit(
          moveDesignPathPoint(path, address, {
            x:
              local.x +
              (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0),
            y:
              local.y +
              (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0),
          }),
        );
      } catch (e) {
        options.error((e as Error).message);
      }
    }
  }
  const overlay =
    editing && drawing && path ? (
      <PathHandles
        points={points}
        lines={lines}
        zoom={options.zoom}
        selected={selected}
        disabled={options.readOnly || !!element?.locked}
        revision={options.content}
        select={selectPoint}
        begin={(id) => {
          const current = latest.current,
            owned = current.element;
          if (current.readOnly || !owned?.path) return false;
          const drawing = current.project(owned)[0];
          if (!drawing) {
            current.error('Show the path and its parent frames before editing points.');
            return false;
          }
          gesture.current = {
            base: current.content,
            path: owned.path,
            drawing,
            id,
          };
          inputs?.changed();
        }}
        preview={(id, world) => {
          const g = gesture.current,
            addr = addresses.get(id);
          if (!g || !addr) return;
          try {
            const next = moveDesignPathPoint(
              g.path,
              addr,
              designPathPoint(g.path, g.drawing, world, true),
            );
            projectDesignPath(next, g.drawing);
            setPreview(next);
          } catch (e) {
            options.error((e as Error).message);
            cancel();
          }
        }}
        commit={(id, world) => {
          const g = gesture.current,
            addr = addresses.get(id);
          cancel();
          if (!g || !addr) return;
          try {
            commit(
              moveDesignPathPoint(g.path, addr, designPathPoint(g.path, g.drawing, world, true)),
              g.base,
            );
          } catch (e) {
            options.error((e as Error).message);
          }
        }}
        cancel={cancel}
      />
    ) : undefined;
  const controls = element?.path ? (
    <fieldset disabled={options.readOnly}>
      <section aria-label="Path editing">
        <button
          type="button"
          disabled={options.readOnly}
          onClick={() => {
            if (!settle()) return;
            if (!editing && options.fit?.() === false) return;
            setActive(editing ? undefined : element.id);
            const first = element.path!.subpaths[0];
            setSelected(pointKey(first.id, first.anchors[0].id));
          }}
        >
          {editing ? 'Finish point editing' : 'Edit path points'}
        </button>
        {editing && (
          <>
            <button
              type="button"
              onClick={() => {
                if (settle()) options.fit?.();
              }}
            >
              Fit path points
            </button>
            {!drawing && (
              <p role="status">Show the path and its parent frames before editing points.</p>
            )}
            <p>
              Tab selects points; arrows move them. Escape finishes. Point insertion/deletion is not
              supported. Fit path points brings all anchors and handles into view.
            </p>
            <label>
              Path point
              <select
                aria-label="Path point"
                value={selected ?? ''}
                onChange={(e) => selectPoint(e.target.value)}
              >
                {points.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {local && address && path && (
              <>
                <CommitInput
                  key={`${element.id}:${selected}:x`}
                  label="Path point X"
                  type="number"
                  value={local.x}
                  onCommit={(value) => {
                    try {
                      if (!value.trim()) throw Error('Enter a path coordinate');
                      return commit(
                        moveDesignPathPoint(path, address, { x: Number(value), y: local.y }),
                      );
                    } catch (e) {
                      options.error((e as Error).message);
                      return false;
                    }
                  }}
                />
                <CommitInput
                  key={`${element.id}:${selected}:y`}
                  label="Path point Y"
                  type="number"
                  value={local.y}
                  onCommit={(value) => {
                    try {
                      if (!value.trim()) throw Error('Enter a path coordinate');
                      return commit(
                        moveDesignPathPoint(path, address, { x: local.x, y: Number(value) }),
                      );
                    } catch (e) {
                      options.error((e as Error).message);
                      return false;
                    }
                  }}
                />
                {'anchorId' in address && (
                  <label>
                    Anchor mode
                    <select
                      aria-label="Anchor mode"
                      disabled={options.readOnly}
                      value={sub?.anchors.find((a) => a.id === address.anchorId)?.mode}
                      onChange={(e) => {
                        try {
                          commit(
                            setDesignAnchorMode(
                              path,
                              address.subpathId,
                              address.anchorId,
                              e.target.value as 'corner' | 'smooth' | 'symmetric',
                            ),
                          );
                        } catch (error) {
                          options.error((error as Error).message);
                        }
                      }}
                    >
                      {['corner', 'smooth', 'symmetric'].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </>
        )}
      </section>
    </fieldset>
  ) : undefined;
  return {
    editing,
    overlay,
    controls,
    keyDown,
    busy: () => !!gesture.current,
    settle,
    project: (d: DesignDrawing) =>
      preview && editing && d.id === element?.id
        ? { ...d, path: projectDesignPath(preview, d) }
        : d,
  };
}
