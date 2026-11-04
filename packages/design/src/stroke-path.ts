import { transaction, type Bounds, type EditorCommand } from '@editor-platform/editor-core';
import { captureDesignData } from './command-data';
import { insertDesignPath } from './path-commands';
import { updateElement, type DesignContent } from './model';
import { designPathLimits, type DesignEditablePath } from './path';

/** Follow the selected stroke's owner so consecutive strokes stay in the chosen page/group. */
export function designStrokeParent(
  content: DesignContent,
  selectedId?: string,
): string | undefined {
  if (!selectedId)
    return content.pagination?.pages[0]?.panelIds[0] ?? content.pagination?.pages[0]?.frameId;
  let element = content.elements.find((e) => e.id === selectedId);
  const visited = new Set<string>();
  while (element && !visited.has(element.id)) {
    if (element.type === 'frame' || element.type === 'group') return element.id;
    visited.add(element.id);
    element = content.elements.find((e) => e.id === element!.parentId);
  }
}

/** Uniform-width vector input only; samples become ordinary editable native anchors. */
export function designStrokePath(raw: readonly { x: number; y: number }[]): DesignEditablePath {
  const samples = captureDesignData(raw, true);
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 2048)
    throw Error('A stroke needs 2–2048 samples');
  const points: { x: number; y: number }[] = [];
  for (const p of samples) {
    if (
      !p ||
      Object.keys(p).sort().join(',') !== 'x,y' ||
      ![p.x, p.y].every(
        (v) =>
          typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= designPathLimits.coordinate,
      )
    )
      throw Error('Invalid stroke sample');
    const previous = points.at(-1);
    if (!previous || previous.x !== p.x || previous.y !== p.y) points.push(p);
  }
  if (points.length < 2) throw Error('Move the pointer to draw a stroke');
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  const frame: Bounds = {
    x,
    y,
    width: Math.max(1, Math.max(...points.map((p) => p.x)) - x),
    height: Math.max(1, Math.max(...points.map((p) => p.y)) - y),
  };
  return {
    frame,
    fillRule: 'nonzero',
    subpaths: [
      {
        id: 'stroke',
        closed: false,
        anchors: points.map((p, i) => ({ id: `a${i}`, ...p, mode: 'corner' })),
        segments: points
          .slice(1)
          .map((_, i) => ({ id: `e${i}`, type: 'line', from: `a${i}`, to: `a${i + 1}` })),
      },
    ],
  };
}
export function insertDesignStroke(
  samples: readonly { x: number; y: number }[],
  parentId?: string,
  writable = () => true,
): EditorCommand<DesignContent> & { elementId: string } {
  const path = designStrokePath(samples),
    insert = insertDesignPath(path, path.frame, parentId, writable);
  return {
    ...transaction('Draw ink stroke', [
      insert,
      updateElement(insert.elementId, {
        name: 'Hand drawn stroke',
        fill: 'none',
        stroke: '#151515',
        strokeWidth: 2.5,
      }),
    ]),
    elementId: insert.elementId,
  };
}
