import { clone, canonicalJson, newId } from '@editor-platform/artifact-core';
import { command, type EditorCommand, type Bounds } from '@editor-platform/editor-core';
import {
  appearance,
  assertDesignContent,
  layoutDesign,
  type DesignContent,
  type DesignElement,
} from './model';
import { validDesignPath, type DesignEditablePath } from './path';

export function remapEditablePath(path: DesignEditablePath): DesignEditablePath {
  const copy = clone(path);
  for (const s of copy.subpaths) {
    s.id = newId('subpath');
    const ids = new Map(s.anchors.map((a) => [a.id, newId('anchor')]));
    for (const a of s.anchors) a.id = ids.get(a.id)!;
    for (const e of s.segments) {
      e.id = newId('segment');
      e.from = ids.get(e.from)!;
      e.to = ids.get(e.to)!;
    }
  }
  return copy;
}
export function presetDesignPath(kind: 'line' | 'cubic'): DesignEditablePath {
  const a = newId('anchor'),
    b = newId('anchor');
  const path: DesignEditablePath = {
    frame: { x: 0, y: 0, width: 220, height: 160 },
    fillRule: 'nonzero',
    subpaths: [
      {
        id: newId('subpath'),
        closed: false,
        anchors: [
          { id: a, x: 0, y: 120, mode: 'corner' },
          { id: b, x: 220, y: 120, mode: 'corner' },
        ],
        segments: [
          kind === 'line'
            ? { id: newId('segment'), type: 'line', from: a, to: b }
            : {
                id: newId('segment'),
                type: 'cubic',
                from: a,
                to: b,
                c1: { x: 40, y: -40 },
                c2: { x: 180, y: -40 },
              },
        ],
      },
    ],
  };
  if (kind === 'cubic') {
    const sub = path.subpaths[0],
      end = newId('anchor');
    sub.anchors[1].x = 110;
    sub.anchors[1].y = 40;
    const first = sub.segments[0];
    if (first.type === 'cubic') first.c2 = { x: 80, y: 40 };
    sub.anchors.push({ id: end, x: 220, y: 120, mode: 'corner' });
    sub.segments.push({
      id: newId('segment'),
      type: 'cubic',
      from: b,
      to: end,
      c1: { x: 140, y: 40 },
      c2: { x: 200, y: 80 },
    });
  }
  return path;
}
export function insertDesignPath(
  path: DesignEditablePath,
  bounds: Bounds = { x: 60, y: 60, width: path.frame.width, height: path.frame.height },
  parentId?: string,
  writable = () => true,
): EditorCommand<DesignContent> & { elementId: string } {
  if (!validDesignPath(path)) throw Error('Invalid Design path');
  const owned = clone(path),
    elementId = newId('design');
  return {
    ...command<DesignContent>('design.path.insert', 'Add path', (d) => {
      if (!writable()) throw Error('Design is read only');
      if (parentId) editable(d, parentId);
      const next = layoutDesign({
        ...d,
        schemaVersion: 3,
        elements: [
          ...d.elements,
          {
            id: elementId,
            type: 'shape',
            name: 'Editable path',
            text: '',
            fill: 'none',
            stroke: '#304a39',
            strokeWidth: 3,
            bounds: clone(bounds),
            path: clone(owned),
            ...(parentId ? { parentId } : {}),
          },
        ],
      });
      assertDesignContent(next);
      return next;
    }),
    elementId,
  };
}
function editable(d: DesignContent, id: string): DesignElement {
  const target = d.elements.find((e) => e.id === id);
  if (!target) throw Error('Path target was deleted');
  let current: DesignElement | undefined = target;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) throw Error('Invalid hierarchy');
    seen.add(current.id);
    if (
      current.locked ||
      current.hidden ||
      appearance(d, current).locked ||
      appearance(d, current).hidden
    )
      throw Error('Path target is locked or hidden');
    current = d.elements.find((e) => e.id === current!.parentId);
  }
  return target;
}
/** Whole dependency snapshot checks the path, parents, geometry and style at commit time. */
export function replaceDesignPath(
  base: DesignContent,
  id: string,
  path: DesignEditablePath,
  writable = () => true,
): EditorCommand<DesignContent> {
  if (!validDesignPath(path)) throw Error('Invalid Design path');
  const expected = canonicalJson(base),
    nextPath = clone(path);
  return command('design.path.edit', 'Edit path', (d) => {
    if (!writable()) throw Error('Design is read only');
    if (canonicalJson(d) !== expected) throw Error('Path edit is stale');
    const target = editable(d, id);
    if (!target.path) throw Error('Target is not an editable path');
    if (canonicalJson(target.path) === canonicalJson(nextPath)) throw Error('Path edit is a no-op');
    const next = {
      ...d,
      elements: d.elements.map((e) => (e.id === id ? { ...e, path: clone(nextPath) } : e)),
    };
    assertDesignContent(next);
    return next;
  });
}
export type DesignPathPointId =
  | { subpathId: string; anchorId: string }
  | { subpathId: string; segmentId: string; side: 'c1' | 'c2' };
/** Anchor moves translate adjacent controls without imposing the saved mode. */
export function moveDesignPathPoint(
  path: DesignEditablePath,
  id: DesignPathPointId,
  to: { x: number; y: number },
): DesignEditablePath {
  const next = clone(path),
    s = next.subpaths.find((s) => s.id === id.subpathId);
  if (!s) throw Error('Unknown subpath');
  if ('anchorId' in id) {
    const a = s.anchors.find((a) => a.id === id.anchorId);
    if (!a) throw Error('Unknown anchor');
    const dx = to.x - a.x,
      dy = to.y - a.y;
    a.x = to.x;
    a.y = to.y;
    for (const e of s.segments)
      if (e.type === 'cubic') {
        if (e.from === a.id) {
          e.c1.x += dx;
          e.c1.y += dy;
        }
        if (e.to === a.id) {
          e.c2.x += dx;
          e.c2.y += dy;
        }
      }
  } else {
    const e = s.segments.find((e) => e.id === id.segmentId);
    if (!e || e.type !== 'cubic') throw Error('Unknown handle');
    e[id.side] = { x: to.x, y: to.y };
    const anchor = s.anchors.find((a) => a.id === (id.side === 'c1' ? e.from : e.to))!;
    if (anchor.mode !== 'corner') {
      const other = s.segments.find(
        (other) =>
          other.type === 'cubic' &&
          (id.side === 'c1' ? other.to === anchor.id : other.from === anchor.id),
      );
      if (other?.type === 'cubic') {
        const side = id.side === 'c1' ? 'c2' : 'c1',
          opposite = other[side];
        const dx = to.x - anchor.x,
          dy = to.y - anchor.y,
          length = Math.hypot(dx, dy);
        // A collapsed smooth handle has no direction: retain the opposite handle.
        if (anchor.mode === 'symmetric' || length > 0) {
          const scale =
            anchor.mode === 'symmetric'
              ? 1
              : Math.hypot(opposite.x - anchor.x, opposite.y - anchor.y) / length;
          other[side] = { x: anchor.x - dx * scale, y: anchor.y - dy * scale };
        }
      }
    }
  }
  if (!validDesignPath(next)) throw Error('Path coordinates exceed limits');
  return next;
}
export function setDesignAnchorMode(
  path: DesignEditablePath,
  subpathId: string,
  anchorId: string,
  mode: 'corner' | 'smooth' | 'symmetric',
): DesignEditablePath {
  const next = clone(path),
    s = next.subpaths.find((s) => s.id === subpathId),
    a = s?.anchors.find((a) => a.id === anchorId);
  if (!a || !s) throw Error('Unknown anchor');
  a.mode = mode;
  const outgoing = s.segments.find((e) => e.from === a.id && e.type === 'cubic'),
    incoming = s.segments.find((e) => e.to === a.id && e.type === 'cubic');
  const reference =
    outgoing?.type === 'cubic'
      ? { segmentId: outgoing.id, side: 'c1' as const, to: outgoing.c1 }
      : incoming?.type === 'cubic'
        ? { segmentId: incoming.id, side: 'c2' as const, to: incoming.c2 }
        : undefined;
  return reference
    ? moveDesignPathPoint(
        next,
        { subpathId, segmentId: reference.segmentId, side: reference.side },
        reference.to,
      )
    : next;
}
