import { captureDesignData } from './command-data';
import { newId } from '@editor-platform/artifact-core';
import {
  command,
  transaction,
  withCommandReads,
  type Bounds,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { insertElement, updateElement, type DesignContent } from './model';
import { insertDesignPath, presetDesignPath } from './path-commands';
import type { DesignEditablePath } from './path';

function ownedBounds(bounds: Bounds): Bounds {
  const value = captureDesignData(bounds, true);
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'height,width,x,y' ||
    !Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v)) ||
    value.width < 1 ||
    value.height < 1
  )
    throw Error('Invalid panel artwork bounds');
  return value;
}
function requirePanel(d: DesignContent, panelId: string) {
  if (!d.pagination?.pages.some((p) => p.panelIds.includes(panelId)))
    throw Error('Select one registered page panel');
}
/** Existing local schema3 path commands; point editing remains in the native Surface. */
export function insertDesignPagePath(
  panelId: string,
  preset: 'line' | 'cubic',
  bounds: Bounds,
): EditorCommand<DesignContent> & { elementId: string } {
  if (!['line', 'cubic'].includes(preset)) throw Error('Unsupported page path preset');
  const insert = insertDesignPath(presetDesignPath(preset), ownedBounds(bounds), panelId);
  return {
    ...withCommandReads(
      command('design.page.path', 'Add panel linework', (d) => {
        requirePanel(d, panelId);
        return insert.apply(d);
      }),
      { content: ['*'] },
    ),
    elementId: insert.elementId,
  };
}
/** Hand-authored line/cubic geometry, never an imported SVG or a second balloon model. */
function speechBalloonPath(): DesignEditablePath {
  const points = [
    [50, 0],
    [100, 30],
    [75, 60],
    [60, 58],
    [70, 80],
    [45, 60],
    [0, 30],
  ];
  const anchors = points.map(([x, y]) => ({ id: newId('anchor'), x, y, mode: 'corner' as const }));
  const controls: Record<number, [number, number, number, number]> = {
    0: [77, 0, 100, 13],
    1: [100, 48, 90, 57],
    5: [20, 60, 0, 47],
    6: [0, 13, 22, 0],
  };
  return {
    frame: { x: 0, y: 0, width: 100, height: 80 },
    fillRule: 'nonzero',
    subpaths: [
      {
        id: newId('subpath'),
        closed: true,
        anchors,
        segments: anchors.map((a, i) => {
          const base = {
            id: newId('segment'),
            from: a.id,
            to: anchors[(i + 1) % anchors.length].id,
          };
          const c = controls[i];
          return c
            ? {
                ...base,
                type: 'cubic' as const,
                c1: { x: c[0], y: c[1] },
                c2: { x: c[2], y: c[3] },
              }
            : { ...base, type: 'line' as const };
        }),
      },
    ],
  };
}
export function insertDesignSpeechBalloon(
  panelId: string,
  bounds: Bounds,
  text: string,
): EditorCommand<DesignContent> & { elementId: string; pathId: string; textId: string } {
  if (typeof text !== 'string' || text.length > 20000)
    throw Error('Balloon dialogue exceeds 20000 UTF-16 units');
  bounds = ownedBounds(bounds);
  const group = insertElement('group', { parentId: panelId, bounds });
  const path = insertDesignPath(speechBalloonPath(), bounds, group.elementId);
  const dialogue = insertElement('text', {
    parentId: group.elementId,
    bounds: {
      x: bounds.x + bounds.width * 0.15,
      y: bounds.y + bounds.height * 0.12,
      width: bounds.width * 0.7,
      height: bounds.height * 0.45,
    },
  });
  const batch = transaction('Insert speech balloon', [
    group,
    updateElement(group.elementId, { name: 'Speech balloon' }),
    path,
    updateElement(path.elementId, {
      name: 'Balloon outline',
      fill: '#ffffff',
      stroke: '#111111',
      strokeWidth: 2,
    }),
    dialogue,
    updateElement(dialogue.elementId, { text, fill: '#111111' }),
  ]);
  return {
    ...withCommandReads(
      command('design.page.balloon', 'Insert speech balloon', (d) => {
        requirePanel(d, panelId);
        return batch.apply(d);
      }),
      { content: ['*'] },
    ),
    elementId: group.elementId,
    pathId: path.elementId,
    textId: dialogue.elementId,
  };
}
